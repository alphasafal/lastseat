import { Router } from 'express';
import { config } from '../config.js';
import { col, toObjectId } from '../db.js';
import { errors } from '../lib/errors.js';
import { parse, schemas } from '../lib/validate.js';
import { canOpenStream, subscribe } from './hub.js';

export const realtimeRouter = Router();

/**
 * GET /api/stream?hackathonId=...&teamId=...
 *
 * One stream per page. Everyone gets the hackathon's public events (the board). Passing a
 * teamId additionally delivers that team's private events (invites, join requests), but only
 * while the caller is a member - the hub re-checks that on every event.
 */
realtimeRouter.get('/stream', async (req, res) => {
  const { hackathonId, teamId } = parse(schemas.streamQuery, req.query);
  const userId = String(req.auth.userId);
  if (!canOpenStream(userId)) throw errors.rateLimited(5);

  const isMember = teamId
    ? (await col
        .teams()
        .countDocuments(
          { _id: toObjectId(teamId), 'members.userId': req.auth.userId },
          { limit: 1 },
        )) > 0
    : false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform also tells the compression middleware and proxies not to buffer the stream.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const unsubscribe = subscribe({
    res,
    userId,
    hackathonId: hackathonId.toLowerCase(),
    teamId: teamId ? teamId.toLowerCase() : null,
    isMember,
  });

  // "ready" is sent after subscribing: anything committed from this point on will arrive
  // as an event, so the client can safely fetch its initial data now.
  res.write('event: ready\ndata: {}\n\n');

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), config.sse.heartbeatMs);
  heartbeat.unref();
  const expiry = config.sse.maxStreamMs
    ? setTimeout(() => res.end(), config.sse.maxStreamMs)
    : null;
  expiry?.unref();

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe();
  });
});
