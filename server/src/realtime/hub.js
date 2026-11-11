// Keeps track of open SSE streams and decides who may see which event.
//
// The hub is fed from a MongoDB change stream on the audit log (see changeStream.js), not from
// the request handlers. So an event reaches clients only after its transaction has committed,
// and it reaches clients connected to *every* server instance, without Redis.

import { config } from '../config.js';
import { auditView } from '../lib/views.js';
import { metrics } from '../lib/metrics.js';

/**
 * @typedef {object} Client
 * @property {import('express').Response} res
 * @property {string} userId
 * @property {string} hackathonId
 * @property {string|null} teamId   the team page this stream is watching, if any
 * @property {boolean} isMember     whether the user is currently a member of that team
 */

/** @type {Map<string, Set<Client>>} */
const byHackathon = new Map();
/** @type {Map<string, number>} */
const streamsPerUser = new Map();

export function canOpenStream(userId) {
  return (streamsPerUser.get(userId) ?? 0) < config.sse.maxStreamsPerUser;
}

export function subscribe(client) {
  let set = byHackathon.get(client.hackathonId);
  if (!set) byHackathon.set(client.hackathonId, (set = new Set()));
  set.add(client);
  streamsPerUser.set(client.userId, (streamsPerUser.get(client.userId) ?? 0) + 1);
  metrics.sseClients.inc();

  return function unsubscribe() {
    if (!set.delete(client)) return;
    if (set.size === 0) byHackathon.delete(client.hackathonId);
    const left = (streamsPerUser.get(client.userId) ?? 1) - 1;
    if (left <= 0) streamsPerUser.delete(client.userId);
    else streamsPerUser.set(client.userId, left);
    metrics.sseClients.dec();
  };
}

function write(client, frame) {
  // A client that cannot keep up is dropped rather than buffered without limit.
  // EventSource reconnects by itself and the UI refetches on every (re)connect.
  if (client.res.writableLength > config.sse.maxBufferedBytes) {
    client.res.destroy();
    return;
  }
  client.res.write(frame);
  metrics.sseEvents.inc();
}

export function frameFor(entry) {
  const payload = {
    ...auditView(entry),
    ...(entry.team ? { team: entry.team } : {}),
    ...(entry.people ? { people: entry.people } : {}),
  };
  // JSON.stringify never emits a raw newline, so the payload cannot break SSE framing.
  return `id: ${entry._id}\nevent: change\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Delivers one committed audit entry to everyone allowed to see it. */
export function publish(entry) {
  const clients = byHackathon.get(String(entry.hackathonId));
  if (!clients) return;

  const teamId = entry.teamId ? String(entry.teamId) : null;
  const actorId = entry.actorId ? String(entry.actorId) : null;
  const subjectId = entry.subjectId ? String(entry.subjectId) : null;
  const isPublic = entry.visibility === 'public';
  const frame = frameFor(entry);

  for (const client of clients) {
    const watchingTeam = teamId !== null && client.teamId === teamId;
    const wasMember = watchingTeam && client.isMember;

    // Membership is re-derived from every snapshot, so a removed member stops receiving
    // the team's private events from the very next one.
    if (watchingTeam) {
      if (entry.team) {
        client.isMember = entry.team.members.some((member) => member.userId === client.userId);
      } else if (entry.type === 'team.deleted') {
        client.isMember = false;
      }
    }

    const involved = client.userId === actorId || client.userId === subjectId;
    if (isPublic || wasMember || (watchingTeam && client.isMember) || involved) {
      write(client, frame);
    }
  }
}

/** Tells every client its picture may be stale (used after the change stream had to restart). */
export function broadcastResync() {
  for (const clients of byHackathon.values()) {
    for (const client of clients) write(client, 'event: resync\ndata: {}\n\n');
  }
}

export function closeAll() {
  for (const clients of byHackathon.values()) {
    for (const client of clients) client.res.end();
  }
}

export function clientCount() {
  let total = 0;
  for (const clients of byHackathon.values()) total += clients.size;
  return total;
}
