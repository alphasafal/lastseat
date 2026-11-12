// The race lab: a public endpoint that stages the headline scenario against the real database
// and reports what happened, so anyone can check the claim on the live deployment.
//
// One run creates a throwaway team with `seats` seats left and `contenders` throwaway people,
// then lets all of them join at the same instant through the same service function a normal
// join uses (teams/service.js -> joinWithInvite). Nothing is simulated: the winners and losers
// are whatever MongoDB decided. Everything the run created is deleted before it answers.

import { Router } from 'express';
import { config } from '../config.js';
import { ObjectId, col, db, withTransaction } from '../db.js';
import { getLabHackathon } from '../hackathons.js';
import { logger } from '../lib/logger.js';
import { hit } from '../lib/rateLimit.js';
import { utcOffsetMinutes } from '../lib/time.js';
import { parse, schemas } from '../lib/validate.js';
import { teamView } from '../lib/views.js';
import * as service from '../teams/service.js';

export const labRouter = Router();

const FIRST_NAMES = [
  'Aarav',
  'Aditi',
  'Akira',
  'Amara',
  'Ananya',
  'Arjun',
  'Bao',
  'Camila',
  'Chen',
  'Dev',
  'Diya',
  'Elena',
  'Emeka',
  'Farah',
  'Hana',
  'Ishaan',
  'Jin',
  'Kabir',
  'Kavya',
  'Lars',
  'Leila',
  'Mateo',
  'Meera',
  'Nia',
  'Noor',
  'Omar',
  'Priya',
  'Rahul',
  'Riya',
  'Rohan',
  'Sana',
  'Sofia',
  'Tariq',
  'Tara',
  'Vikram',
  'Wei',
  'Yuki',
  'Zainab',
  'Zoe',
  'Neha',
];
const LAST_INITIALS = 'ABCDGJKMNPRSTVWY';
const STALE_AFTER_MS = 10 * 60 * 1000;

function person(runId, index, at) {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_INITIALS[Math.floor(index / FIRST_NAMES.length) % LAST_INITIALS.length];
  return {
    _id: new ObjectId(),
    email: `lab-${runId}-${index}@lab.lastseat.test`,
    name: `${first} ${last}.`,
    skills: [],
    timezone: 'UTC',
    passwordHash: 'lab account, cannot sign in',
    lab: runId,
    createdAt: at,
  };
}

function participantOf(hackathon, user, at) {
  return {
    _id: new ObjectId(),
    hackathonId: hackathon._id,
    userId: user._id,
    name: user.name,
    skills: [],
    headline: '',
    timezone: user.timezone,
    utcOffsetMinutes: utcOffsetMinutes(user.timezone, at),
    lookingForTeam: true,
    teamId: null,
    createdAt: at,
    updatedAt: at,
  };
}

const actorOf = (user) => ({ userId: user._id, name: user.name });

/** Removes what one run created, or (with no arguments) whatever crashed runs left behind. */
async function cleanUp(hackathon, { userIds, teamId } = {}) {
  const lab = { hackathonId: hackathon._id };
  if (userIds) {
    await Promise.all([
      col.teams().deleteMany({ ...lab, _id: teamId }),
      col.invites().deleteMany({ ...lab, teamId }),
      col.participants().deleteMany({ ...lab, userId: { $in: userIds } }),
      col.audit().deleteMany({ ...lab, $or: [{ teamId }, { actorId: { $in: userIds } }] }),
      col.users().deleteMany({ _id: { $in: userIds } }),
    ]);
    return;
  }
  const stale = new Date(Date.now() - STALE_AFTER_MS);
  await Promise.all([
    col.teams().deleteMany({ ...lab, createdAt: { $lt: stale } }),
    col.invites().deleteMany({ ...lab, createdAt: { $lt: stale } }),
    col.participants().deleteMany({ ...lab, createdAt: { $lt: stale } }),
    col.audit().deleteMany({ ...lab, at: { $lt: stale } }),
    col.users().deleteMany({ lab: { $exists: true }, createdAt: { $lt: stale } }),
  ]);
}

labRouter.post('/race', async (req, res) => {
  const { contenders, seats } = parse(schemas.labRace, req.body);
  await hit('lab:ip', req.ip, config.rateLimits.labPerIp);
  await hit('lab:all', 'all', config.rateLimits.labGlobal);

  const hackathon = await getLabHackathon();
  await cleanUp(hackathon);

  const runId = new ObjectId().toString();
  const at = new Date();
  const alreadySeated = hackathon.maxTeamSize - seats; // the leader plus members before the race
  const everyone = Array.from({ length: alreadySeated + contenders }, (_, i) =>
    person(runId, i, at),
  );
  const [leader, ...rest] = everyone;
  const members = rest.slice(0, alreadySeated - 1);
  const racers = rest.slice(alreadySeated - 1);
  const userIds = everyone.map((user) => user._id);
  let teamId = null;

  try {
    await col.users().insertMany(everyone);
    await col.participants().insertMany(everyone.map((user) => participantOf(hackathon, user, at)));

    // Set the stage through the normal code path: create a team, mint a code, fill it
    // until exactly `seats` seats are left.
    const created = await withTransaction((session) =>
      service.createTeam(session, {
        hackathon,
        actor: actorOf(leader),
        input: { name: `Race ${runId.slice(-6)}`, description: '', lookingFor: [] },
      }),
    );
    teamId = new ObjectId(created.body.team.id);
    const invited = await withTransaction((session) =>
      service.createInvite(session, {
        actor: actorOf(leader),
        teamId,
        input: { expiresInMinutes: 5 },
      }),
    );
    const { code } = invited.body.invite;
    for (const user of members) {
      await withTransaction((session) =>
        service.joinWithInvite(session, { actor: actorOf(user), user, code }),
      );
    }

    // Open one connection per contender before the clock starts. Otherwise the first run on
    // a cold pool would mostly measure TLS handshakes instead of the contention.
    await Promise.all(racers.map(() => db().command({ ping: 1 })));

    // The race. Every contender starts in the same tick of the event loop.
    const startedAt = performance.now();
    let finished = 0;
    const results = await Promise.all(
      racers.map(async (user, index) => {
        let attempts = 0;
        let outcome;
        try {
          await withTransaction((session) => {
            attempts += 1;
            return service.joinWithInvite(session, { actor: actorOf(user), user, code });
          });
          outcome = 'JOINED';
        } catch (err) {
          outcome = err.code ?? 'ERROR';
        }
        finished += 1;
        return {
          contender: index + 1,
          name: user.name,
          outcome,
          attempts,
          finishedAs: finished,
          ms: Math.round(performance.now() - startedAt),
        };
      }),
    );
    const durationMs = Math.round(performance.now() - startedAt);

    // Read back what is actually stored and check it, rather than trusting the responses.
    const [team, seated, joinsLogged] = await Promise.all([
      col.teams().findOne({ _id: teamId }),
      col.participants().countDocuments({ hackathonId: hackathon._id, teamId }),
      col.audit().countDocuments({ teamId, type: 'member.joined' }),
    ]);
    const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
    const joined = count('JOINED');
    const full = count('TEAM_FULL');
    const memberIds = team.members.map((member) => String(member.userId));
    const winners = results.filter((result) => result.outcome === 'JOINED');
    const checks = [
      {
        label: `Exactly ${seats} of ${contenders} requests succeeded`,
        ok: joined === seats,
      },
      {
        label: `The other ${contenders - seats} were all told the team is full`,
        ok: full === contenders - seats,
      },
      {
        label: `The stored team has ${hackathon.maxTeamSize} members and nobody twice`,
        ok:
          team.memberCount === hackathon.maxTeamSize &&
          team.members.length === hackathon.maxTeamSize &&
          new Set(memberIds).size === memberIds.length,
      },
      {
        label: 'The people in the stored team are the ones whose requests succeeded',
        ok: winners.every((winner) => memberIds.includes(String(racers[winner.contender - 1]._id))),
      },
      {
        label: 'Open seats is 0, and nobody else is recorded as a member anywhere',
        ok: team.openSeats === 0 && seated === hackathon.maxTeamSize,
      },
      {
        label: `The audit log holds exactly ${hackathon.maxTeamSize - 1} joins for this team`,
        ok: joinsLogged === hackathon.maxTeamSize - 1,
      },
    ];

    const retries = results.reduce((sum, result) => sum + result.attempts - 1, 0);
    const passed = checks.every((check) => check.ok);
    logger.info(
      { contenders, seats, durationMs, totalMs: Date.now() - at.getTime(), retries, passed },
      'race lab run',
    );

    res.json({
      contenders,
      seats,
      durationMs,
      joined,
      teamFull: full,
      other: contenders - joined - full,
      retries,
      passed,
      checks,
      results,
      team: teamView(team),
    });
  } finally {
    await cleanUp(hackathon, { userIds, teamId }).catch(() => {});
  }
});
