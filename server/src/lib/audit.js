import { invalidateBoard } from '../board/cache.js';
import { ObjectId, col, onCommit } from '../db.js';
import { personView, teamView } from './views.js';

// Events anyone on the hackathon board may see. Everything else (invites, join requests)
// is delivered only to the team's members and the people named in the entry.
const PUBLIC_TYPES = new Set([
  'team.created',
  'team.updated',
  'team.deleted',
  'member.joined',
  'member.left',
  'member.removed',
  'leader.changed',
  'participant.updated',
]);

/**
 * Builds one audit entry. `team` and `people` are snapshots taken after the change; they are
 * what the live board renders, so a client never has to compute state from a diff.
 *
 * @param {object} entry
 * @param {string} entry.type e.g. "member.joined"
 * @param {ObjectId} entry.hackathonId
 * @param {ObjectId|null} [entry.teamId]
 * @param {{userId: ObjectId, name: string}} entry.actor who did it
 * @param {{userId: ObjectId, name: string}} [entry.subject] who it was done to, if not the actor
 * @param {object} [entry.data] small, type-specific details
 * @param {object|null} [entry.team] team document after the change
 * @param {object[]} [entry.people] participant documents after the change
 * @param {Date} entry.at
 */
export function auditEntry({ type, hackathonId, teamId, actor, subject, data, team, people, at }) {
  return {
    _id: new ObjectId(),
    type,
    visibility: PUBLIC_TYPES.has(type) ? 'public' : 'team',
    hackathonId,
    teamId: teamId ?? null,
    actorId: actor.userId,
    actorName: actor.name,
    subjectId: subject?.userId ?? null,
    subjectName: subject?.name ?? null,
    at,
    data: data ?? {},
    ...(team ? { team: teamView(team) } : {}),
    ...(people?.length ? { people: people.map(personView) } : {}),
  };
}

/**
 * Writes entries inside the caller's transaction. Because the entry commits or rolls back
 * together with the change it describes, the log cannot disagree with the data - and because
 * the live stream is fed from this collection, clients only ever hear about committed changes.
 */
export async function writeAudit(session, entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  await col.audit().insertMany(list, { session });
  // Read-your-writes on this instance: the person who made the change sees it on their very
  // next board fetch, without waiting for the change stream to deliver the event.
  onCommit(session, () => list.forEach(invalidateBoard));
}
