import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.logLevel,
  // Never let a credential reach the logs, whatever a future log line includes.
  redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.code'],
});
