import { createApp } from './app.js';
import { connect, ensureIndexes } from './db.js';
import { ensureDefaultHackathon } from './hackathons.js';
import { logger } from './lib/logger.js';
import { startChangeStream } from './realtime/changeStream.js';
import { watchForPauses } from './suspension.js';

/**
 * Connects to MongoDB, makes sure the indexes and the demo hackathon exist, starts the change
 * stream that feeds live updates, and returns the Express app.
 *
 * Shared by the long-running server (index.js) and the serverless entry (api/index.js). On a
 * serverless platform this is the cold start, so each step is timed and logged.
 */
export async function boot() {
  const startedAt = performance.now();
  const timings = {};
  const step = async (name, work) => {
    const from = performance.now();
    await work();
    timings[name] = Math.round(performance.now() - from);
  };

  await step('connectMs', connect);
  await step('indexesMs', ensureIndexes);
  await step('hackathonMs', ensureDefaultHackathon);
  await step('changeStreamMs', startChangeStream);
  watchForPauses();
  const app = createApp();

  logger.info({ ...timings, totalMs: Math.round(performance.now() - startedAt) }, 'booted');
  return app;
}
