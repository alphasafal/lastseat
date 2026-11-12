import { boot } from './boot.js';
import { config } from './config.js';
import { disconnect } from './db.js';
import { logger } from './lib/logger.js';
import { stopChangeStream } from './realtime/changeStream.js';
import { closeAll } from './realtime/hub.js';

const server = (await boot()).listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'lastseat listening');
});

// Long-lived SSE responses must not be cut by Node's default request timeouts.
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  // Stop accepting work, let in-flight requests finish, then release the database.
  closeAll();
  await stopChangeStream();
  server.close(async () => {
    await disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
