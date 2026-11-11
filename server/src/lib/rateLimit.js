import { col } from '../db.js';
import { errors, isDuplicateKey } from './errors.js';
import { metrics } from './metrics.js';

/**
 * Fixed-window counter stored in MongoDB.
 *
 * It lives in the database rather than in process memory on purpose: with two server
 * instances an in-memory limiter would give an attacker twice the guesses.
 *
 * @param {string} name which limit, e.g. "invite-join:user"
 * @param {string} subject who is being limited (user id, IP, email)
 * @param {{limit: number, windowSec: number}} rule
 */
export async function hit(name, subject, rule) {
  const windowMs = rule.windowSec * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const id = `${name}:${subject}:${windowStart}`;
  const update = {
    $inc: { count: 1 },
    $setOnInsert: { expiresAt: new Date(windowStart + windowMs) },
  };

  let doc;
  try {
    doc = await col
      .rateLimits()
      .findOneAndUpdate({ _id: id }, update, { upsert: true, returnDocument: 'after' });
  } catch (err) {
    // Two first-hits in the same window can both try to insert; the loser simply increments.
    if (!isDuplicateKey(err)) throw err;
    doc = await col.rateLimits().findOneAndUpdate({ _id: id }, update, { returnDocument: 'after' });
  }

  if (doc.count > rule.limit) {
    metrics.rateLimited.inc({ limit: name });
    throw errors.rateLimited(Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 1000)));
  }
  return { remaining: rule.limit - doc.count };
}

/**
 * In-memory limiter for the general per-session ceiling. Losing these counters on restart or
 * splitting them across instances only makes the cap looser, which is acceptable for a
 * politeness limit and avoids a database write on every request.
 */
export function memoryLimiter(rule, keyOf) {
  const windowMs = rule.windowSec * 1000;
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }, windowMs);
  sweep.unref();

  return function limit(req, _res, next) {
    const key = keyOf(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > rule.limit) {
      metrics.rateLimited.inc({ limit: 'api' });
      throw errors.rateLimited(Math.ceil((bucket.resetAt - now) / 1000));
    }
    next();
  };
}
