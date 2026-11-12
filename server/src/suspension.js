// Recovering from a suspended process.
//
// A serverless host does not stop an idle instance, it freezes it: no code runs, no timer
// fires, and the sockets to MongoDB stay open on our side while the other side forgets them.
// When a request thaws the instance, the driver still believes in those sockets, sends the
// first query down one of them and waits for an answer that never comes. On the hosted demo
// that was a 10 second stall on the first request after a quiet couple of minutes.
//
// The fix is to notice the freeze. A timer notes the wall-clock time once a second; if more
// time has passed than a running process could have missed, the process was suspended, and
// the database client and the change stream are replaced before anything else uses them.
// Nothing can be in flight at that moment: an instance is only frozen when it has no requests.

import { config } from './config.js';
import { reconnect } from './db.js';
import { logger } from './lib/logger.js';
import { restartChangeStream } from './realtime/changeStream.js';

const TICK_MS = 1000;
let lastSeenRunning = Date.now();
let recovering = null;

/**
 * Compares the clock with the last time the process was known to be running and starts a
 * recovery if the gap is too long. Returns the recovery in progress, if any.
 */
export function checkForPause(now = Date.now()) {
  const pausedMs = now - lastSeenRunning;
  lastSeenRunning = now;
  if (!recovering && config.reconnectAfterPauseMs > 0 && pausedMs > config.reconnectAfterPauseMs) {
    const startedAt = performance.now();
    recovering = reconnect()
      .then(restartChangeStream)
      .then(() => {
        const reconnectMs = Math.round(performance.now() - startedAt);
        logger.info({ pausedMs, reconnectMs }, 'resumed after a pause, reconnected');
      })
      .catch((err) => logger.error({ err }, 'could not reconnect after a pause'))
      .finally(() => {
        recovering = null;
        lastSeenRunning = Date.now();
      });
  }
  return recovering;
}

/** Starts the once-a-second check. Call once, at boot. */
export function watchForPauses() {
  if (config.reconnectAfterPauseMs > 0) setInterval(checkForPause, TICK_MS).unref();
}

/**
 * Express middleware, first in the chain. After a thaw the request may run before the timer
 * does, so it checks too, and it waits for a recovery that is under way.
 */
export async function afterPause(_req, _res, next) {
  await checkForPause();
  next();
}
