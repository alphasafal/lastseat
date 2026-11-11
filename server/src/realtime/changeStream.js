import { col } from '../db.js';
import { logger } from '../lib/logger.js';
import { broadcastResync, publish } from './hub.js';

let stream = null;
let stopped = false;
let resumeToken = null;

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
  const options = resumeToken ? { resumeAfter: resumeToken } : {};
  stream = col.audit().watch([{ $match: { operationType: 'insert' } }], options);

  stream.on('change', (change) => {
    resumeToken = change._id;
    try {
      publish(change.fullDocument);
    } catch (err) {
      logger.error({ err }, 'failed to publish change');
    }
  });

  stream.on('error', (err) => {
    if (stopped) return;
    logger.warn({ err: err.message }, 'change stream error, reopening');
    stream.close().catch(() => {});
    const couldNotResume = resumeToken !== null && /resume/i.test(err.message);
    if (couldNotResume) resumeToken = null;
    setTimeout(() => {
      if (stopped) return;
      open();
      if (couldNotResume) broadcastResync();
    }, 1000).unref();
  });
}

export async function stopChangeStream() {
  stopped = true;
  await stream?.close().catch(() => {});
  stream = null;
}
