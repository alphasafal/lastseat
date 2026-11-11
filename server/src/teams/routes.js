import { Router } from 'express';
import { config } from '../config.js';
import { col, toObjectId } from '../db.js';
import { getHackathon } from '../hackathons.js';
import { errors } from '../lib/errors.js';
import { mutate, send } from '../lib/idempotency.js';
import { metrics } from '../lib/metrics.js';
import { hit } from '../lib/rateLimit.js';
import { parse, parseId, schemas } from '../lib/validate.js';
import { auditView, inviteView, joinRequestView, personView, teamView } from '../lib/views.js';
import * as service from './service.js';

export const teamsRouter = Router();

const actorOf = (req) => ({ userId: req.auth.userId, name: req.auth.name });
const idParam = (req, name) => toObjectId(parseId(req.params[name], name));

async function loadUser(req) {
  const user = await col.users().findOne({ _id: req.auth.userId });
  if (!user) throw errors.unauthenticated();
  return user;
}

/** Counts the outcome of a seat claim once per request, however many times the transaction ran. */
async function countingSeatClaim(via, run) {
  try {
    const result = await run();
    metrics.seatClaims.inc({ via, result: result.replayed ? 'replayed' : 'won' });
    return result;
  } catch (err) {
    metrics.seatClaims.inc({ via, result: err.code ?? 'error' });
    throw err;
  }
}

// --- Participation in a hackathon ---------------------------------------------------------

teamsRouter.post('/hackathons/:hackathonId/participants', async (req, res) => {
  const hackathon = await getHackathon(idParam(req, 'hackathonId'));
  const user = await loadUser(req);
  send(res, await mutate(req, (session) => service.registerParticipant(session, { hackathon, user })));
});

teamsRouter.get('/hackathons/:hackathonId/me', async (req, res) => {
  const hackathonId = idParam(req, 'hackathonId');
  const me = await col.participants().findOne({ hackathonId, userId: req.auth.userId });
  const team = me?.teamId ? await col.teams().findOne({ _id: me.teamId }) : null;
  res.json({ me: me ? personView(me) : null, team: team ? teamView(team) : null });
});

teamsRouter.patch('/hackathons/:hackathonId/me', async (req, res) => {
  const hackathon = await getHackathon(idParam(req, 'hackathonId'));
  const input = parse(schemas.participantUpdate, req.body);
  send(
    res,
    await mutate(req, (session) =>
      service.updateParticipant(session, { hackathon, actor: actorOf(req), input }),
    ),
  );
});

// --- Teams --------------------------------------------------------------------------------

teamsRouter.post('/hackathons/:hackathonId/teams', async (req, res) => {
  const hackathon = await getHackathon(idParam(req, 'hackathonId'));
  const input = parse(schemas.teamCreate, req.body);
  send(
    res,
    await mutate(req, (session) =>
      service.createTeam(session, { hackathon, actor: actorOf(req), input }),
    ),
  );
});

teamsRouter.get('/teams/:teamId', async (req, res) => {
  const team = await col.teams().findOne({ _id: idParam(req, 'teamId') });
  if (!team) throw errors.notFound('Team');
  res.json({ team: teamView(team) });
});

teamsRouter.patch('/teams/:teamId', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  const input = parse(schemas.teamUpdate, req.body);
  send(
    res,
    await mutate(req, (session) =>
      service.updateTeam(session, { actor: actorOf(req), teamId, input }),
    ),
  );
});

teamsRouter.post('/teams/:teamId/leave', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  send(res, await mutate(req, (session) => service.leaveTeam(session, { actor: actorOf(req), teamId })));
});

teamsRouter.delete('/teams/:teamId/members/:userId', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  const userId = idParam(req, 'userId');
  send(
    res,
    await mutate(req, (session) =>
      service.removeMember(session, { actor: actorOf(req), teamId, userId }),
    ),
  );
});

teamsRouter.put('/teams/:teamId/leader', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  const { userId } = parse(schemas.userIdBody, req.body);
  send(
    res,
    await mutate(req, (session) =>
      service.transferLeadership(session, {
        actor: actorOf(req),
        teamId,
        userId: toObjectId(userId),
      }),
    ),
  );
});

// --- Invite codes -------------------------------------------------------------------------

async function requireLeader(teamId, userId) {
  const team = await col.teams().findOne({ _id: teamId }, { projection: { leaderId: 1 } });
  if (!team) throw errors.notFound('Team');
  if (String(team.leaderId) !== String(userId)) throw errors.notLeader();
}

teamsRouter.get('/teams/:teamId/invites', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  await requireLeader(teamId, req.auth.userId);
  const invites = await col
    .invites()
    .find({ teamId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ expiresAt: -1 })
    .toArray();
  res.json({ invites: invites.map((invite) => inviteView(invite)) });
});

teamsRouter.post('/teams/:teamId/invites', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  const input = parse(schemas.inviteCreate, req.body);
  send(
    res,
    await mutate(req, (session) =>
      service.createInvite(session, { actor: actorOf(req), teamId, input }),
    ),
  );
});

teamsRouter.delete('/teams/:teamId/invites/:inviteId', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  const inviteId = idParam(req, 'inviteId');
  send(
    res,
    await mutate(req, (session) =>
      service.revokeInvite(session, { actor: actorOf(req), teamId, inviteId }),
    ),
  );
});

teamsRouter.post('/invites/join', async (req, res) => {
  // Limits are checked before the code is even parsed, so malformed guesses count too.
  await hit('invite-join:user', String(req.auth.userId), config.rateLimits.inviteJoinPerUser);
  await hit('invite-join:ip', req.ip, config.rateLimits.inviteJoinPerIp);
  const { code } = parse(schemas.inviteJoin, req.body);
  const user = await loadUser(req);
  const result = await countingSeatClaim('invite', () =>
    mutate(req, (session) =>
      service.joinWithInvite(session, { actor: actorOf(req), user, code }),
    ),
  );
  send(res, result);
});

// --- Join requests ------------------------------------------------------------------------

teamsRouter.post('/teams/:teamId/requests', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  const input = parse(schemas.joinRequestCreate, req.body);
  send(
    res,
    await mutate(req, (session) =>
      service.createJoinRequest(session, { actor: actorOf(req), teamId, input }),
    ),
  );
});

teamsRouter.get('/teams/:teamId/requests', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  await requireLeader(teamId, req.auth.userId);
  const requests = await col
    .joinRequests()
    .find({ teamId, status: 'pending' })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  res.json({ requests: requests.map(joinRequestView) });
});

teamsRouter.get('/hackathons/:hackathonId/requests/mine', async (req, res) => {
  const hackathonId = idParam(req, 'hackathonId');
  const requests = await col
    .joinRequests()
    .find({ hackathonId, userId: req.auth.userId })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  res.json({ requests: requests.map(joinRequestView) });
});

teamsRouter.post('/requests/:requestId/accept', async (req, res) => {
  const requestId = idParam(req, 'requestId');
  const result = await countingSeatClaim('request', () =>
    mutate(req, (session) =>
      service.acceptJoinRequest(session, { actor: actorOf(req), requestId }),
    ),
  );
  send(res, result);
});

teamsRouter.post('/requests/:requestId/decline', async (req, res) => {
  const requestId = idParam(req, 'requestId');
  send(
    res,
    await mutate(req, (session) =>
      service.declineJoinRequest(session, { actor: actorOf(req), requestId }),
    ),
  );
});

teamsRouter.post('/requests/:requestId/cancel', async (req, res) => {
  const requestId = idParam(req, 'requestId');
  send(
    res,
    await mutate(req, (session) =>
      service.cancelJoinRequest(session, { actor: actorOf(req), requestId }),
    ),
  );
});

// --- Audit log ----------------------------------------------------------------------------

teamsRouter.get('/teams/:teamId/audit', async (req, res) => {
  const teamId = idParam(req, 'teamId');
  const { before, limit } = parse(schemas.auditQuery, req.query);

  // Current members can read their team's history. Once the team is deleted nobody is a
  // member any more, so its log is reachable only through the organiser endpoint below.
  const isMember = await col
    .teams()
    .countDocuments({ _id: teamId, 'members.userId': req.auth.userId }, { limit: 1 });
  if (!isMember) throw errors.forbidden('Only team members can read the team history.');

  const filter = { teamId, ...(before ? { _id: { $lt: toObjectId(before) } } : {}) };
  const entries = await col
    .audit()
    .find(filter, { projection: { team: 0, people: 0 } })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  res.json({ entries: entries.map(auditView) });
});

teamsRouter.get('/hackathons/:hackathonId/audit', async (req, res) => {
  const hackathonId = idParam(req, 'hackathonId');
  const { before, limit } = parse(schemas.auditQuery, req.query);
  const user = await loadUser(req);
  if (user.role !== 'organizer') throw errors.forbidden('Only organisers can read the full log.');

  const filter = { hackathonId, ...(before ? { _id: { $lt: toObjectId(before) } } : {}) };
  const entries = await col
    .audit()
    .find(filter, { projection: { team: 0, people: 0 } })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  res.json({ entries: entries.map(auditView) });
});
