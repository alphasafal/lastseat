import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { authRouter } from './auth/routes.js';
import { loadSession, requireAuth, requireSameOrigin } from './auth/sessions.js';
import { boardRouter } from './board/routes.js';
import { config } from './config.js';
import { db } from './db.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { metrics, registry } from './lib/metrics.js';
import { memoryLimiter } from './lib/rateLimit.js';
import { clientCount } from './realtime/hub.js';
import { realtimeRouter } from './realtime/routes.js';
import { teamsRouter } from './teams/routes.js';

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // Request id + latency histogram, labelled with the route template (not the raw URL)
  // so ids in paths do not explode the number of time series.
  app.use((req, res, next) => {
    req.id = req.get('x-request-id')?.slice(0, 64) || randomUUID();
    res.set('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      metrics.httpDuration.observe({ method: req.method, route, status: res.statusCode }, seconds);
      logger.debug({
        id: req.id,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Math.round(seconds * 1000),
      });
    });
    next();
  });

  app.get('/healthz', async (_req, res) => {
    await db().command({ ping: 1 });
    res.json({ ok: true, streams: clientCount() });
  });

  app.get('/metrics', async (req, res) => {
    if (config.metricsToken && req.get('authorization') !== `Bearer ${config.metricsToken}`) {
      return res.status(401).end();
    }
    res.set('Content-Type', registry.contentType).send(await registry.metrics());
  });

  app.use(compression());
  app.use('/api', express.json({ limit: '16kb', strict: true }));
  app.use('/api', requireSameOrigin, loadSession);

  app.use('/api/auth', authRouter);

  const api = express.Router();
  api.use(requireAuth);
  api.use(memoryLimiter(config.rateLimits.apiPerUser, (req) => String(req.auth.userId)));
  api.use(realtimeRouter);
  api.use(boardRouter);
  api.use(teamsRouter);
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'No such endpoint.')));

  // In production the same process serves the built React app, so the API and the UI share
  // an origin: cookies stay first-party and no CORS configuration is needed at all.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(WEB_DIST, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}

// Express recognizes an error handler by its four parameters, so `_next` has to stay.
function errorHandler(err, req, res, _next) {
  if (res.headersSent) return res.destroy();

  if (err instanceof AppError) {
    if (err.details?.retryAfterSec) {
      res.set('Retry-After', String(err.details.retryAfterSec));
    }
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, ...err.details } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'VALIDATION_FAILED', message: 'Request body is not valid JSON.' } });
  }
  if (err?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }

  logger.error({ err, id: req.id, url: req.originalUrl }, 'unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Something went wrong on our side.', requestId: req.id },
  });
}
