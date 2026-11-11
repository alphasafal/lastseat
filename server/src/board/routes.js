import { Router } from 'express';
import { config } from '../config.js';
import { col, toObjectId } from '../db.js';
import { getHackathon, listHackathons } from '../hackathons.js';
import { errors } from '../lib/errors.js';
import { parse, parseId, schemas } from '../lib/validate.js';
import { hackathonView, personView, teamView } from '../lib/views.js';
import { rankCandidates } from './score.js';

export const boardRouter = Router();

// --- Keyset pagination ----------------------------------------------------------------------
// Pages are addressed by the (updatedAt, _id) of the last row seen, never by an offset, so
// page 300 costs the same as page 1 and rows that move while you scroll are not skipped twice.

function encodeCursor(doc) {
  return Buffer.from(JSON.stringify([doc.updatedAt.getTime(), String(doc._id)])).toString(
    'base64url',
  );
}

function decodeCursor(raw) {
  try {
    const [ms, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(ms)) throw new Error('bad timestamp');
    return { updatedAt: new Date(ms), _id: toObjectId(parseId(id, 'cursor')) };
  } catch {
    throw errors.validation([{ path: 'cursor', message: 'is not a valid cursor' }]);
  }
}

function afterCursor(cursor) {
  if (!cursor) return {};
  const { updatedAt, _id } = decodeCursor(cursor);
  return {
    // The first condition gives the index a tight bound; the $or breaks ties on _id.
    updatedAt: { $lte: updatedAt },
    $or: [{ updatedAt: { $lt: updatedAt } }, { _id: { $lt: _id } }],
  };
}

async function page(collection, filter, indexName, limit, view) {
  const docs = await collection
    .find(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .hint(indexName)
    .limit(limit + 1)
    .toArray();
  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  return {
    items: items.map(view),
    nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
  };
}

// --- Totals ---------------------------------------------------------------------------------
// Counting is the only part of the board that grows with the data, so it is cached for a few
// seconds. The live stream keeps the visible rows exact; the header numbers may lag slightly.

const totalsCache = new Map();

async function boardTotals(hackathonId) {
  const key = String(hackathonId);
  const hit = totalsCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const [openTeams, peopleLooking] = await Promise.all([
    col.teams().countDocuments({ hackathonId, openSeats: { $gt: 0 } }, { hint: 'board_teams' }),
    col
      .participants()
      .countDocuments({ hackathonId, lookingForTeam: true }, { hint: 'board_people' }),
  ]);
  const value = { openTeams, peopleLooking };
  totalsCache.set(key, { value, until: Date.now() + config.board.countCacheMs });
  return value;
}

// --- Routes ---------------------------------------------------------------------------------

boardRouter.get('/hackathons', async (_req, res) => {
  res.json({ hackathons: (await listHackathons()).map(hackathonView) });
});

boardRouter.get('/hackathons/:hackathonId', async (req, res) => {
  const hackathon = await getHackathon(parseId(req.params.hackathonId, 'hackathonId'));
  res.json({ hackathon: hackathonView(hackathon), totals: await boardTotals(hackathon._id) });
});

boardRouter.get('/hackathons/:hackathonId/board/teams', async (req, res) => {
  const hackathonId = toObjectId(parseId(req.params.hackathonId, 'hackathonId'));
  const { skill, cursor, limit } = parse(schemas.boardQuery, req.query);
  const filter = {
    hackathonId,
    openSeats: { $gt: 0 },
    ...(skill ? { lookingFor: skill } : {}),
    ...afterCursor(cursor),
  };
  const [result, totals] = await Promise.all([
    page(col.teams(), filter, skill ? 'board_teams_by_skill' : 'board_teams', limit, teamView),
    boardTotals(hackathonId),
  ]);
  res.json({ ...result, totals });
});

boardRouter.get('/hackathons/:hackathonId/board/people', async (req, res) => {
  const hackathonId = toObjectId(parseId(req.params.hackathonId, 'hackathonId'));
  const { skill, cursor, limit } = parse(schemas.boardQuery, req.query);
  const filter = {
    hackathonId,
    lookingForTeam: true,
    ...(skill ? { skills: skill } : {}),
    ...afterCursor(cursor),
  };
  const [result, totals] = await Promise.all([
    page(
      col.participants(),
      filter,
      skill ? 'board_people_by_skill' : 'board_people',
      limit,
      personView,
    ),
    boardTotals(hackathonId),
  ]);
  res.json({ ...result, totals });
});

boardRouter.get('/hackathons/:hackathonId/suggestions', async (req, res) => {
  const hackathonId = toObjectId(parseId(req.params.hackathonId, 'hackathonId'));
  const { limit } = parse(schemas.suggestionsQuery, req.query);

  const me = await col.participants().findOne({ hackathonId, userId: req.auth.userId });
  if (!me) throw errors.notRegistered();
  const team = me.teamId ? await col.teams().findOne({ _id: me.teamId }) : null;

  // Suggestions are for the whole team when you have one, otherwise just for you.
  const members = team ? team.members : [me];
  const have = [...new Set(members.flatMap((member) => member.skills))];
  const wanted = (team?.lookingFor ?? []).filter((skill) => !have.includes(skill));
  const context = {
    have,
    wanted,
    offsets: members.map((member) => member.utcOffsetMinutes),
  };

  const candidates = await loadCandidates(hackathonId, req.auth.userId, wanted);
  const ranked = rankCandidates(context, candidates, config.suggestions).slice(0, limit);

  res.json({
    basedOn: team ? { kind: 'team', teamId: String(team._id), name: team.name } : { kind: 'you' },
    context: { have, wanted },
    considered: candidates.length,
    scoring: {
      weights: config.suggestions.weights,
      activeWindow: config.suggestions.activeWindow,
      explanation: [
        'wanted: share of the skills your team is looking for (and does not have yet) that this person brings.',
        'complementary: skills this person has that nobody on your team has; each is worth a third, up to three.',
        'timezone: average share of the 09:00-22:00 local day this person shares with each of your members.',
        'score = 100 x weighted sum. If your team lists no wanted skills, that weight is split between the other two.',
      ],
    },
    suggestions: ranked.map(({ candidate, ...scored }) => ({
      person: personView(candidate),
      ...scored,
    })),
  });
});

/**
 * Scoring 10,000 people per request would be wasteful, so the pool is narrowed in the
 * database first: people who have a skill the team wants, topped up with the most recently
 * active people. `considered` in the response says how many were actually scored.
 */
async function loadCandidates(hackathonId, selfId, wanted) {
  const size = config.suggestions.candidatePool;
  const base = { hackathonId, lookingForTeam: true, userId: { $ne: selfId } };
  const recent = (filter, n, index) =>
    col.participants().find(filter).sort({ updatedAt: -1, _id: -1 }).hint(index).limit(n).toArray();

  const pool = new Map();
  if (wanted.length > 0) {
    const perSkill = Math.ceil(size / wanted.length);
    const lists = await Promise.all(
      wanted.map((skill) => recent({ ...base, skills: skill }, perSkill, 'board_people_by_skill')),
    );
    for (const doc of lists.flat()) pool.set(String(doc._id), doc);
  }
  if (pool.size < size) {
    for (const doc of await recent(base, size, 'board_people')) {
      if (pool.size >= size) break;
      pool.set(String(doc._id), doc);
    }
  }
  return [...pool.values()];
}
