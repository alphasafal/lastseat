// Every change to a team goes through this file. Each function runs inside a transaction
// (see lib/idempotency.js -> mutate) and may be re-run by the driver after a write conflict,
// so none of them keeps state outside the database.

import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { INDEX, ObjectId, col, retryTransaction } from '../db.js';
import { auditEntry, writeAudit } from '../lib/audit.js';
import { errors, isDuplicateKey } from '../lib/errors.js';
import { inviteView, joinRequestView, personView, teamView } from '../lib/views.js';
import { utcOffsetMinutes } from '../lib/time.js';

// Crockford base32: no I, L, O or U, so a code read aloud or typed from a photo is unambiguous.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const INVITE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const sameId = (a, b) => String(a) === String(b);

export function hashInviteCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

export function generateInviteCode() {
  // 32 symbols divide 256 evenly, so masking five bits of each random byte is unbiased.
  const bytes = randomBytes(config.invite.codeLength);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
  return code;
}

function memberFrom(participant, at) {
  return {
    userId: participant.userId,
    name: participant.name,
    skills: participant.skills,
    utcOffsetMinutes: participant.utcOffsetMinutes,
    joinedAt: at,
  };
}

async function requireParticipant(session, hackathonId, userId) {
  const participant = await col.participants().findOne({ hackathonId, userId }, { session });
  if (!participant) throw errors.notRegistered();
  return participant;
}

/** Test-only hook: lets the chaos test kill the process between two writes of a transaction. */
function failpoint(name) {
  if (config.failpoint === name) process.kill(process.pid, 'SIGKILL');
}

// ---------------------------------------------------------------------------------------
// The seat claim. This one update is the whole answer to "50 people, one seat".
// ---------------------------------------------------------------------------------------

/**
 * Atomically takes one seat in a team for `participant`.
 *
 * The filter and the update are evaluated by MongoDB as a single operation on one document:
 *   - `openSeats > 0`           the seat must still exist at the instant of the write
 *   - `members.userId != user`  the same person is never added twice (retry, double click)
 *   - `leaderId == actor`       when a leader accepts a request, they must still be the leader
 * and the unique index on (hackathonId, members.userId) refuses the write if the person is
 * already in any other team of this hackathon.
 *
 * There is no read-then-write here, so there is no window for another request to slip into.
 *
 * @returns {Promise<{team: object, alreadyMember: boolean}>}
 */
async function claimSeat(session, { teamId, participant, at, requireLeaderId }) {
  const filter = {
    _id: teamId,
    openSeats: { $gt: 0 },
    'members.userId': { $ne: participant.userId },
    ...(requireLeaderId ? { leaderId: requireLeaderId } : {}),
  };
  const update = {
    $push: { members: memberFrom(participant, at) },
    $inc: { memberCount: 1, openSeats: -1, version: 1 },
    $set: { updatedAt: at },
  };

  let team;
  try {
    team = await col.teams().findOneAndUpdate(filter, update, { session, returnDocument: 'after' });
  } catch (err) {
    if (isDuplicateKey(err, INDEX.memberPerHackathon)) {
      throw requireLeaderId ? errors.subjectAlreadyInTeam() : errors.alreadyInTeam();
    }
    throw err;
  }
  if (team) return { team, alreadyMember: false };

  // Nothing matched. Read the document once to say why; this read decides nothing.
  const current = await col.teams().findOne({ _id: teamId }, { session });
  if (!current) throw errors.notFound('Team');
  if (requireLeaderId && !sameId(current.leaderId, requireLeaderId)) throw errors.notLeader();
  if (current.members.some((member) => sameId(member.userId, participant.userId))) {
    return { team: current, alreadyMember: true };
  }
  throw errors.teamFull();
}

/** Bookkeeping that must commit together with a successful seat claim. */
async function afterJoin(session, { team, participant, actor, via, at, exceptRequestId }) {
  failpoint('after-seat-claim');

  const person = await col
    .participants()
    .findOneAndUpdate(
      { _id: participant._id },
      { $set: { teamId: team._id, lookingForTeam: false, updatedAt: at } },
      { session, returnDocument: 'after' },
    );

  // Joining a team withdraws the person's requests to every other team.
  const stale = await col
    .joinRequests()
    .find(
      {
        hackathonId: team.hackathonId,
        userId: participant.userId,
        status: 'pending',
        ...(exceptRequestId ? { _id: { $ne: exceptRequestId } } : {}),
      },
      { session },
    )
    .toArray();
  if (stale.length > 0) {
    await col
      .joinRequests()
      .updateMany(
        { _id: { $in: stale.map((request) => request._id) }, status: 'pending' },
        { $set: { status: 'cancelled', reason: 'joined_a_team', decidedAt: at } },
        { session },
      );
  }

  const joiner = { userId: participant.userId, name: participant.name };
  await writeAudit(session, [
    auditEntry({
      type: 'member.joined',
      hackathonId: team.hackathonId,
      teamId: team._id,
      actor,
      subject: joiner,
      data: { via },
      team,
      people: [person],
      at,
    }),
    ...stale.map((request) =>
      auditEntry({
        type: 'request.cancelled',
        hackathonId: team.hackathonId,
        teamId: request.teamId,
        actor: joiner,
        data: { requestId: String(request._id), reason: 'joined_a_team' },
        at,
      }),
    ),
  ]);

  failpoint('before-commit');
  return person;
}

// ---------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------

export async function createTeam(session, { hackathon, actor, input }) {
  const participant = await requireParticipant(session, hackathon._id, actor.userId);
  const at = new Date();
  const team = {
    _id: new ObjectId(),
    hackathonId: hackathon._id,
    name: input.name,
    nameKey: input.name.toLowerCase(),
    description: input.description,
    lookingFor: input.lookingFor,
    leaderId: actor.userId,
    members: [memberFrom(participant, at)],
    memberCount: 1,
    minSize: hackathon.minTeamSize,
    maxSize: hackathon.maxTeamSize,
    openSeats: hackathon.maxTeamSize - 1,
    acceptingRequests: true,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };

  try {
    // The creator is a member from the first write, so the same unique index that guards
    // joins also makes it impossible for one person to create two teams.
    await col.teams().insertOne(team, { session });
  } catch (err) {
    if (isDuplicateKey(err, INDEX.memberPerHackathon)) throw errors.alreadyInTeam();
    if (isDuplicateKey(err, INDEX.teamName)) throw errors.teamNameTaken();
    throw err;
  }

  const person = await afterCreate(session, { team, participant, actor, at });
  return { status: 201, body: { team: teamView(team), me: personView(person) } };
}

async function afterCreate(session, { team, participant, actor, at }) {
  const person = await col
    .participants()
    .findOneAndUpdate(
      { _id: participant._id },
      { $set: { teamId: team._id, lookingForTeam: false, updatedAt: at } },
      { session, returnDocument: 'after' },
    );
  const stale = await col
    .joinRequests()
    .updateMany(
      { hackathonId: team.hackathonId, userId: participant.userId, status: 'pending' },
      { $set: { status: 'cancelled', reason: 'joined_a_team', decidedAt: at } },
      { session },
    );
  await writeAudit(
    session,
    auditEntry({
      type: 'team.created',
      hackathonId: team.hackathonId,
      teamId: team._id,
      actor,
      data: { name: team.name, withdrawnRequests: stale.modifiedCount },
      team,
      people: [person],
      at,
    }),
  );
  return person;
}

export async function updateTeam(session, { actor, teamId, input }) {
  const at = new Date();
  const set = { ...input, updatedAt: at };
  if (input.name) set.nameKey = input.name.toLowerCase();

  let team;
  try {
    team = await col
      .teams()
      .findOneAndUpdate(
        { _id: teamId, leaderId: actor.userId },
        { $set: set, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      );
  } catch (err) {
    if (isDuplicateKey(err, INDEX.teamName)) throw errors.teamNameTaken();
    throw err;
  }
  if (!team) await explainLeaderMiss(session, teamId);

  await writeAudit(
    session,
    auditEntry({
      type: 'team.updated',
      hackathonId: team.hackathonId,
      teamId,
      actor,
      data: { changed: Object.keys(input) },
      team,
      at,
    }),
  );
  return { status: 200, body: { team: teamView(team) } };
}

/** A leader-only update matched nothing: either the team is gone or the actor is not its leader. */
async function explainLeaderMiss(session, teamId) {
  const exists = await col.teams().countDocuments({ _id: teamId }, { session, limit: 1 });
  throw exists ? errors.notLeader() : errors.notFound('Team');
}

// ---------------------------------------------------------------------------------------
// Leaving, removing, passing on leadership
// ---------------------------------------------------------------------------------------

/**
 * Takes one member out of a team. Shared by "leave" and "remove".
 *
 * Rules applied here:
 *   - the last member leaving deletes the team (and closes its invites and requests)
 *   - if the leader leaves, the longest-standing remaining member becomes leader
 *
 * The write is guarded by the `version` that was read, so if the team changed in between
 * the request fails with CONFLICT instead of acting on a stale picture.
 */
async function detachMember(session, { team, member, actor, type, at }) {
  const remaining = team.members.filter((m) => !sameId(m.userId, member.userId));
  const subject = { userId: member.userId, name: member.name };
  const base = { hackathonId: team.hackathonId, teamId: team._id, actor, at };
  let after = null;
  let nextLeader = null;

  if (remaining.length === 0) {
    const deleted = await col
      .teams()
      .deleteOne({ _id: team._id, version: team.version }, { session });
    if (deleted.deletedCount !== 1) throw errors.conflict();
    await col
      .invites()
      .updateMany(
        { teamId: team._id, revokedAt: null },
        { $set: { revokedAt: at, purgeAt: new Date(at.getTime() + INVITE_RETENTION_MS) } },
        { session },
      );
    await col
      .joinRequests()
      .updateMany(
        { teamId: team._id, status: 'pending' },
        { $set: { status: 'cancelled', reason: 'team_deleted', decidedAt: at } },
        { session },
      );
  } else {
    // Members are appended on join, so array order is join order.
    if (sameId(team.leaderId, member.userId)) nextLeader = remaining[0];
    after = await col.teams().findOneAndUpdate(
      { _id: team._id, version: team.version },
      {
        $pull: { members: { userId: member.userId } },
        $inc: { memberCount: -1, openSeats: 1, version: 1 },
        $set: { updatedAt: at, ...(nextLeader ? { leaderId: nextLeader.userId } : {}) },
      },
      { session, returnDocument: 'after' },
    );
    if (!after) throw errors.conflict();
  }

  const person = await col
    .participants()
    .findOneAndUpdate(
      { hackathonId: team.hackathonId, userId: member.userId },
      { $set: { teamId: null, lookingForTeam: true, updatedAt: at } },
      { session, returnDocument: 'after' },
    );

  const entries = [
    auditEntry({ ...base, type, subject, team: after, people: person ? [person] : [] }),
  ];
  if (nextLeader) {
    entries.push(
      auditEntry({
        ...base,
        type: 'leader.changed',
        subject: { userId: nextLeader.userId, name: nextLeader.name },
        data: { reason: 'previous_leader_left', previousLeaderId: String(member.userId) },
        team: after,
      }),
    );
  }
  if (!after) {
    entries.push(auditEntry({ ...base, type: 'team.deleted', data: { name: team.name } }));
  }
  await writeAudit(session, entries);

  return { team: after, person };
}

export async function leaveTeam(session, { actor, teamId }) {
  const team = await col.teams().findOne({ _id: teamId }, { session });
  if (!team) throw errors.notFound('Team');
  const member = team.members.find((m) => sameId(m.userId, actor.userId));
  if (!member) throw errors.notAMember();

  const { team: after, person } = await detachMember(session, {
    team,
    member,
    actor,
    type: 'member.left',
    at: new Date(),
  });
  return {
    status: 200,
    body: { team: after ? teamView(after) : null, teamDeleted: !after, me: personView(person) },
  };
}

export async function removeMember(session, { actor, teamId, userId }) {
  const team = await col.teams().findOne({ _id: teamId }, { session });
  if (!team) throw errors.notFound('Team');
  if (!sameId(team.leaderId, actor.userId)) throw errors.notLeader();
  if (sameId(userId, actor.userId)) {
    throw errors.validation([{ path: 'userId', message: 'use "leave" to remove yourself' }]);
  }
  const member = team.members.find((m) => sameId(m.userId, userId));
  if (!member) throw errors.notAMember();

  const { team: after } = await detachMember(session, {
    team,
    member,
    actor,
    type: 'member.removed',
    at: new Date(),
  });
  return { status: 200, body: { team: teamView(after) } };
}

export async function transferLeadership(session, { actor, teamId, userId }) {
  const at = new Date();
  // Leader check and membership check are part of the write, not a read before it.
  const team = await col
    .teams()
    .findOneAndUpdate(
      { _id: teamId, leaderId: actor.userId, 'members.userId': userId },
      { $set: { leaderId: userId, updatedAt: at }, $inc: { version: 1 } },
      { session, returnDocument: 'after' },
    );
  if (!team) {
    const current = await col.teams().findOne({ _id: teamId }, { session });
    if (!current) throw errors.notFound('Team');
    if (!sameId(current.leaderId, actor.userId)) throw errors.notLeader();
    throw errors.notAMember();
  }
  const next = team.members.find((m) => sameId(m.userId, userId));
  await writeAudit(
    session,
    auditEntry({
      type: 'leader.changed',
      hackathonId: team.hackathonId,
      teamId,
      actor,
      subject: { userId: next.userId, name: next.name },
      data: { reason: 'transferred', previousLeaderId: String(actor.userId) },
      team,
      at,
    }),
  );
  return { status: 200, body: { team: teamView(team) } };
}

// ---------------------------------------------------------------------------------------
// Invite codes
// ---------------------------------------------------------------------------------------

export async function createInvite(session, { actor, teamId, input }) {
  const at = new Date();
  // Touching the team serializes concurrent invite creation, which keeps the cap exact.
  const team = await col
    .teams()
    .findOneAndUpdate(
      { _id: teamId, leaderId: actor.userId },
      { $set: { lastInviteAt: at } },
      { session, returnDocument: 'after' },
    );
  if (!team) await explainLeaderMiss(session, teamId);

  const active = await col
    .invites()
    .countDocuments({ teamId, revokedAt: null, expiresAt: { $gt: at } }, { session });
  if (active >= config.invite.maxActivePerTeam) {
    throw errors.tooManyInvites(config.invite.maxActivePerTeam);
  }

  const code = generateInviteCode();
  const expiresAt = new Date(at.getTime() + input.expiresInMinutes * 60_000);
  const invite = {
    _id: new ObjectId(),
    teamId,
    hackathonId: team.hackathonId,
    // Only the hash is stored: reading the database does not reveal a usable code.
    codeHash: hashInviteCode(code),
    hint: code.slice(-4),
    createdBy: actor.userId,
    createdAt: at,
    expiresAt,
    revokedAt: null,
    uses: 0,
    purgeAt: new Date(expiresAt.getTime() + INVITE_RETENTION_MS),
  };
  await col.invites().insertOne(invite, { session });

  await writeAudit(
    session,
    auditEntry({
      type: 'invite.created',
      hackathonId: team.hackathonId,
      teamId,
      actor,
      data: { inviteId: String(invite._id), hint: invite.hint, expiresAt },
      at,
    }),
  );
  return { status: 201, body: { invite: inviteView(invite, code) } };
}

export async function revokeInvite(session, { actor, teamId, inviteId }) {
  const at = new Date();
  const isLeader = await col
    .teams()
    .countDocuments({ _id: teamId, leaderId: actor.userId }, { session, limit: 1 });
  if (!isLeader) await explainLeaderMiss(session, teamId);

  const invite = await col
    .invites()
    .findOneAndUpdate(
      { _id: inviteId, teamId, revokedAt: null },
      { $set: { revokedAt: at } },
      { session, returnDocument: 'after' },
    );
  if (!invite) {
    const existing = await col.invites().findOne({ _id: inviteId, teamId }, { session });
    if (!existing) throw errors.notFound('Invite');
    // Revoking twice is a no-op, not an error.
    return { status: 200, body: { invite: inviteView(existing) } };
  }

  await writeAudit(
    session,
    auditEntry({
      type: 'invite.revoked',
      hackathonId: invite.hackathonId,
      teamId,
      actor,
      data: { inviteId: String(invite._id), hint: invite.hint },
      at,
    }),
  );
  return { status: 200, body: { invite: inviteView(invite) } };
}

export async function joinWithInvite(session, { actor, user, code }) {
  const at = new Date();
  // Expiry is compared with the server clock inside the query; the TTL index only cleans up.
  const invite = await col
    .invites()
    .findOne(
      { codeHash: hashInviteCode(code), revokedAt: null, expiresAt: { $gt: at } },
      { session },
    );
  if (!invite) throw errors.inviteInvalid();

  const hackathon = await col.hackathons().findOne({ _id: invite.hackathonId }, { session });
  const participant = await ensureParticipant(session, { hackathon, user, at });

  const { team, alreadyMember } = await claimSeat(session, {
    teamId: invite.teamId,
    participant,
    at,
  });
  if (alreadyMember) {
    return { status: 200, body: { team: teamView(team), alreadyMember: true } };
  }

  await col.invites().updateOne({ _id: invite._id }, { $inc: { uses: 1 } }, { session });
  const person = await afterJoin(session, { team, participant, actor, via: 'invite', at });
  return {
    status: 200,
    body: { team: teamView(team), alreadyMember: false, me: personView(person) },
  };
}

// ---------------------------------------------------------------------------------------
// Join requests
// ---------------------------------------------------------------------------------------

export async function createJoinRequest(session, { actor, teamId, input }) {
  const at = new Date();
  const team = await col.teams().findOne({ _id: teamId }, { session });
  if (!team) throw errors.notFound('Team');

  // Writing to the participant makes two of this user's requests conflict with each other
  // and with a join, so the "not in a team" and "max pending" checks below cannot be raced.
  const participant = await col
    .participants()
    .findOneAndUpdate(
      { hackathonId: team.hackathonId, userId: actor.userId },
      { $set: { lastRequestAt: at } },
      { session, returnDocument: 'after' },
    );
  if (!participant) throw errors.notRegistered();
  if (participant.teamId) throw errors.alreadyInTeam();
  if (!team.acceptingRequests) throw errors.requestsClosed();
  if (team.openSeats === 0) throw errors.teamFull();

  const pending = await col
    .joinRequests()
    .countDocuments(
      { hackathonId: team.hackathonId, userId: actor.userId, status: 'pending' },
      { session },
    );
  if (pending >= config.joinRequest.maxPendingPerUser) {
    throw errors.tooManyRequests(config.joinRequest.maxPendingPerUser);
  }

  const request = {
    _id: new ObjectId(),
    hackathonId: team.hackathonId,
    teamId,
    teamName: team.name,
    userId: actor.userId,
    userName: participant.name,
    userSkills: participant.skills,
    userUtcOffsetMinutes: participant.utcOffsetMinutes,
    message: input.message,
    status: 'pending',
    createdAt: at,
  };
  try {
    await col.joinRequests().insertOne(request, { session });
  } catch (err) {
    if (isDuplicateKey(err, INDEX.pendingRequest)) throw errors.requestExists();
    throw err;
  }

  await writeAudit(
    session,
    auditEntry({
      type: 'request.created',
      hackathonId: team.hackathonId,
      teamId,
      actor,
      data: { requestId: String(request._id) },
      at,
    }),
  );
  return { status: 201, body: { request: joinRequestView(request) } };
}

async function loadPendingRequest(session, requestId) {
  const request = await col.joinRequests().findOne({ _id: requestId }, { session });
  if (!request) throw errors.notFound('Join request');
  if (request.status !== 'pending') throw errors.requestNotPending();
  return request;
}

async function decideRequest(session, request, status, actor, at) {
  const decided = await col
    .joinRequests()
    .findOneAndUpdate(
      { _id: request._id, status: 'pending' },
      { $set: { status, decidedAt: at, decidedBy: actor.userId } },
      { session, returnDocument: 'after' },
    );
  if (!decided) throw errors.requestNotPending();
  return decided;
}

export async function acceptJoinRequest(session, { actor, requestId }) {
  const at = new Date();
  const request = await loadPendingRequest(session, requestId);
  const participant = await requireParticipant(session, request.hackathonId, request.userId);

  // Same atomic claim as an invite join, with one more condition: the actor is the leader.
  const { team, alreadyMember } = await claimSeat(session, {
    teamId: request.teamId,
    participant,
    at,
    requireLeaderId: actor.userId,
  });
  const decided = await decideRequest(session, request, 'accepted', actor, at);
  if (alreadyMember) {
    return { status: 200, body: { request: joinRequestView(decided), team: teamView(team) } };
  }
  await afterJoin(session, {
    team,
    participant,
    actor,
    via: 'request',
    at,
    exceptRequestId: request._id,
  });
  await writeAudit(
    session,
    auditEntry({
      type: 'request.accepted',
      hackathonId: team.hackathonId,
      teamId: team._id,
      actor,
      subject: { userId: participant.userId, name: participant.name },
      data: { requestId: String(request._id) },
      at,
    }),
  );
  return { status: 200, body: { request: joinRequestView(decided), team: teamView(team) } };
}

export async function declineJoinRequest(session, { actor, requestId }) {
  const at = new Date();
  const request = await loadPendingRequest(session, requestId);
  const isLeader = await col
    .teams()
    .countDocuments({ _id: request.teamId, leaderId: actor.userId }, { session, limit: 1 });
  if (!isLeader) await explainLeaderMiss(session, request.teamId);

  const decided = await decideRequest(session, request, 'declined', actor, at);
  await writeAudit(
    session,
    auditEntry({
      type: 'request.declined',
      hackathonId: request.hackathonId,
      teamId: request.teamId,
      actor,
      subject: { userId: request.userId, name: request.userName },
      data: { requestId: String(request._id) },
      at,
    }),
  );
  return { status: 200, body: { request: joinRequestView(decided) } };
}

export async function cancelJoinRequest(session, { actor, requestId }) {
  const at = new Date();
  const request = await col.joinRequests().findOne({ _id: requestId }, { session });
  if (!request || !sameId(request.userId, actor.userId)) throw errors.notFound('Join request');
  if (request.status !== 'pending') throw errors.requestNotPending();

  const decided = await col
    .joinRequests()
    .findOneAndUpdate(
      { _id: requestId, status: 'pending' },
      { $set: { status: 'cancelled', reason: 'withdrawn', decidedAt: at } },
      { session, returnDocument: 'after' },
    );
  if (!decided) throw errors.requestNotPending();

  await writeAudit(
    session,
    auditEntry({
      type: 'request.cancelled',
      hackathonId: request.hackathonId,
      teamId: request.teamId,
      actor,
      data: { requestId: String(request._id), reason: 'withdrawn' },
      at,
    }),
  );
  return { status: 200, body: { request: joinRequestView(decided) } };
}

// ---------------------------------------------------------------------------------------
// Participants (a user's registration in one hackathon)
// ---------------------------------------------------------------------------------------

function participantFrom(hackathon, user, at) {
  return {
    _id: new ObjectId(),
    hackathonId: hackathon._id,
    userId: user._id,
    name: user.name,
    skills: user.skills,
    headline: '',
    timezone: user.timezone,
    utcOffsetMinutes: utcOffsetMinutes(user.timezone, at),
    lookingForTeam: true,
    teamId: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** Returns the user's participant record for a hackathon, creating it on first use. */
export async function ensureParticipant(session, { hackathon, user, at = new Date() }) {
  const existing = await col
    .participants()
    .findOne({ hackathonId: hackathon._id, userId: user._id }, { session });
  if (existing) return existing;
  const participant = participantFrom(hackathon, user, at);
  try {
    await col.participants().insertOne(participant, { session });
  } catch (err) {
    // A parallel request registered this user after our snapshot was taken: start over and
    // the lookup above will find the record.
    if (isDuplicateKey(err, INDEX.participant)) throw retryTransaction('participant exists');
    throw err;
  }
  await writeAudit(
    session,
    auditEntry({
      type: 'participant.updated',
      hackathonId: hackathon._id,
      actor: { userId: user._id, name: user.name },
      data: { registered: true },
      people: [participant],
      at,
    }),
  );
  return participant;
}

export async function registerParticipant(session, { hackathon, user }) {
  const participant = await ensureParticipant(session, { hackathon, user });
  return { status: 200, body: { me: personView(participant) } };
}

export async function updateParticipant(session, { hackathon, actor, input }) {
  const at = new Date();
  const current = await requireParticipant(session, hackathon._id, actor.userId);
  if (input.lookingForTeam === true && current.teamId) throw errors.alreadyInTeam();

  const set = { ...input, updatedAt: at };
  if (input.timezone) set.utcOffsetMinutes = utcOffsetMinutes(input.timezone, at);
  const person = await col
    .participants()
    .findOneAndUpdate({ _id: current._id }, { $set: set }, { session, returnDocument: 'after' });

  // The team document carries a copy of each member's skills and offset for the board.
  let team = null;
  if (person.teamId && (input.skills || input.timezone)) {
    team = await col.teams().findOneAndUpdate(
      { _id: person.teamId, 'members.userId': actor.userId },
      {
        $set: {
          'members.$.skills': person.skills,
          'members.$.utcOffsetMinutes': person.utcOffsetMinutes,
          updatedAt: at,
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after' },
    );
  }

  await writeAudit(
    session,
    auditEntry({
      type: 'participant.updated',
      hackathonId: hackathon._id,
      teamId: team?._id ?? null,
      actor,
      data: { changed: Object.keys(input) },
      team,
      people: [person],
      at,
    }),
  );
  return { status: 200, body: { me: personView(person) } };
}
