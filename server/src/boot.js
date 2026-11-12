import { createApp } from './app.js';
import { connect, ensureIndexes } from './db.js';
import { ensureDefaultHackathon } from './hackathons.js';
import { startChangeStream } from './realtime/changeStream.js';

/**
 * Connects to MongoDB, makes sure the indexes and the demo hackathon exist, starts the change
 * stream that feeds live updates, and returns the Express app.
 *
 * Shared by the long-running server (index.js) and the serverless entry (api/index.js).
 */
export async function boot() {
  await connect();
  await ensureIndexes();
  await ensureDefaultHackathon();
  await startChangeStream();
  return createApp();
}
