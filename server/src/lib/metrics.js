import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const metrics = {
  httpDuration: new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Request duration by route template and status.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5],
    registers: [registry],
  }),
  // How often a transaction lost a race and had to run again. Spikes here mean contention.
  txnRetries: new client.Counter({
    name: 'txn_retries_total',
    help: 'Transaction callbacks re-run after a transient error (write conflict).',
    registers: [registry],
  }),
  seatClaims: new client.Counter({
    name: 'seat_claims_total',
    help: 'Attempts to take a seat in a team, by outcome.',
    labelNames: ['via', 'result'],
    registers: [registry],
  }),
  idempotentReplays: new client.Counter({
    name: 'idempotent_replays_total',
    help: 'Requests answered from a stored result instead of being executed again.',
    registers: [registry],
  }),
  rateLimited: new client.Counter({
    name: 'rate_limited_total',
    help: 'Requests rejected by a rate limit.',
    labelNames: ['limit'],
    registers: [registry],
  }),
  sseClients: new client.Gauge({
    name: 'sse_clients',
    help: 'Open server-sent event streams.',
    registers: [registry],
  }),
  sseEvents: new client.Counter({
    name: 'sse_events_sent_total',
    help: 'Events written to SSE streams.',
    registers: [registry],
  }),
};
