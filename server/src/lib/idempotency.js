import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { col, withTransaction } from '../db.js';
import { errors } from './errors.js';
import { metrics } from './metrics.js';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function readKey(req) {
  const key = req.get('Idempotency-Key');
  if (key === undefined) return null;
  if (!KEY_PATTERN.test(key)) {
    throw errors.validation([
      { path: 'Idempotency-Key', message: 'must be 8-128 characters of A-Z a-z 0-9 _ -' },
    ]);
  }
  return key;
}

function fingerprint(req) {
  return createHash('sha256')
    .update(`${req.method} ${req.originalUrl.split('?')[0]} ${JSON.stringify(req.body ?? {})}`)
    .digest('hex');
}

/**
 * Runs a state change exactly once per (user, Idempotency-Key).
 *
 * The stored result is inserted in the same transaction as the change itself, so there is no
 * moment where the change exists without its record or the record exists without the change.
 *
 * Two copies of one request arriving together (a double click) both find no record, both do
 * the work, and both try to insert the same _id. MongoDB lets one commit; the other gets a
 * write conflict, the transaction is retried from the top, finds the record and replays it.
 *
 * Only successful results are stored. A request that failed changed nothing, so running it
 * again is safe and returns the truth as of now.
 *
 * @param {import('express').Request} req
 * @param {(session: import('mongodb').ClientSession) => Promise<{status: number, body: object}>} work
 */
export async function mutate(req, work) {
  const key = readKey(req);
  if (!key) return withTransaction(work);

  const id = `${req.auth.userId}:${key}`;
  const print = fingerprint(req);

  return withTransaction(async (session) => {
    const prior = await col.idempotency().findOne({ _id: id }, { session });
    if (prior) {
      if (prior.fingerprint !== print) throw errors.idempotencyKeyReused();
      metrics.idempotentReplays.inc();
      return { status: prior.status, body: prior.body, replayed: true };
    }

    const result = await work(session);

    const now = new Date();
    await col.idempotency().insertOne(
      {
        _id: id,
        fingerprint: print,
        status: result.status,
        body: result.body,
        createdAt: now,
        expiresAt: new Date(now.getTime() + config.idempotency.ttlMs),
      },
      { session },
    );
    return result;
  });
}

export function send(res, result) {
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
}
