// A small cache for board pages that is emptied by the same events that drive the live stream.
//
// Why it stays correct: a client first subscribes to the stream, then fetches the board.
// Take any change C. Either its event is published after the client subscribed, and the
// client receives it; or it was published before, and at that moment this cache was emptied,
// so the fetch that follows is answered from a query that already sees C. A page can therefore
// never be missing a change that the client will not also hear about.
//
// The TTL is only a safety net for the case where the change stream is down.

import { gzipSync } from 'node:zlib';

const TTL_MS = 2000;
const MAX_ENTRIES_PER_HACKATHON = 400;

/** @type {Map<string, Map<string, {body: Promise<{json: Buffer, gzip: Buffer}>, until: number}>>} */
const byHackathon = new Map();

export const stats = { hits: 0, misses: 0 };

/**
 * Returns the encoded page for `key`, producing it at most once however many requests ask
 * for it at the same time (they all await the same promise).
 *
 * @param {string} hackathonId
 * @param {string} key everything that distinguishes the page: kind, skill, cursor, limit
 * @param {() => Promise<object>} produce runs the database queries
 */
export function cachedPage(hackathonId, key, produce) {
  let entries = byHackathon.get(hackathonId);
  if (!entries) byHackathon.set(hackathonId, (entries = new Map()));

  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.until > now) {
    stats.hits += 1;
    return hit.body;
  }
  stats.misses += 1;

  const body = produce().then((page) => {
    const json = Buffer.from(JSON.stringify(page));
    return { json, gzip: gzipSync(json, { level: 4 }) };
  });
  if (entries.size >= MAX_ENTRIES_PER_HACKATHON) entries.clear();
  // The promise is stored before the query finishes. If an event arrives meanwhile, the map
  // is cleared and this entry goes with it, so a result computed from an older snapshot can
  // never be put back after the invalidation.
  entries.set(key, { body, until: now + TTL_MS });
  body.catch(() => {
    if (entries.get(key)?.body === body) entries.delete(key);
  });
  return body;
}

/** Called for every committed change in a hackathon, before the event is sent to clients. */
export function invalidateBoard(hackathonId) {
  byHackathon.get(String(hackathonId))?.clear();
}

export function invalidateAllBoards() {
  byHackathon.clear();
}

/** Writes an encoded page, already compressed when the client accepts gzip. */
export function sendPage(req, res, page) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(req.get('accept-encoding') ?? '')) {
    res.set('Content-Encoding', 'gzip');
    res.end(page.gzip);
  } else {
    res.end(page.json);
  }
}
