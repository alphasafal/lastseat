import { col } from '../db.js';
import { logger } from '../lib/logger.js';
import { broadcastResync, publish } from './hub.js';

let stream = null;
let stopped = false;
let resumeToken = null;
// Incremented whenever the stream is replaced, so a late callback from an old one is ignored.
let generation = 0;

/**
 * Tails inserts on the audit log and hands each one to the hub.
 *
 * If the stream breaks it is reopened from the last token it saw, so no committed event is
 * skipped. If even that fails (the token fell off the oplog) the stream starts from "now" and
 * every client is told to refetch, which is always correct, just more expensive.
 */
export async function startChangeStream() {
  stopped = false;
  open();
}

function open() {
  generation += 1;
  const mine = generation;
  const options = resumeToken ? { resumeAfter: resumeToken } : {};
  const current = col.audit().watch([{ $match: { operationType: 'insert' } }], options);
  stream = current;

  current.on('change', (change) => {
    if (mine !== generation) return;
    resumeToken = change._id;
    try {
      publish(change.fullDocument);
    } catch (err) {
      logger.error({ err }, 'failed to publish change');
    }
  });

  current.on('error', (err) => {
    if (stopped || mine !== generation) return;
    logger.warn({ err: err.message }, 'change stream error, reopening');
    current.close().catch(() => {});
    const couldNotResume = resumeToken !== null && /resume/i.test(err.message);
    if (couldNotResume) resumeToken = null;
    setTimeout(() => {
      if (stopped || mine !== generation) return;
      open();
      if (couldNotResume) broadcastResync();
    }, 1000).unref();
  });
}

/**
 * Opens a new stream on the current database client and abandons the old one. Used after the
 * client was replaced; the resume token carries over, so nothing committed meanwhile is lost.
 */
export async function restartChangeStream() {
  if (stopped) return;
  const previous = stream;
  open();
  // Not awaited: the old stream belongs to a client whose sockets may be dead.
  previous?.close().catch(() => {});
}

export async function stopChangeStream() {
  stopped = true;
  await stream?.close().catch(() => {});
  stream = null;
}
