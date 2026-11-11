// All tunables live here so the rules of the system can be read in one place.

const env = process.env;

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: int('PORT', 4000),
  mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lastseat?replicaSet=rs0',
  trustProxy: int('TRUST_PROXY', 0),
  metricsToken: env.METRICS_TOKEN ?? '',
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),

  // A transaction that keeps losing races gives up after this long and the client is told
  // to retry, instead of holding a request open indefinitely.
  txnDeadlineMs: int('TXN_DEADLINE_MS', 8000),

  session: {
    cookieName: 'sid',
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  },

  invite: {
    // 12 symbols from a 32-symbol alphabet = 60 bits. See docs/DESIGN.md for the brute-force maths.
    codeLength: 12,
    defaultTtlHours: 48,
    minTtlMinutes: 5,
    maxTtlHours: 7 * 24,
    maxActivePerTeam: 5,
  },

  joinRequest: {
    maxPendingPerUser: 5,
  },

  idempotency: {
    ttlMs: 24 * 60 * 60 * 1000,
  },

  // Fixed-window limits, counted in MongoDB so they hold across server instances.
  rateLimits: {
    loginPerEmail: { limit: 10, windowSec: 15 * 60 },
    authPerIp: { limit: int('RATE_AUTH_PER_IP', 300), windowSec: 15 * 60 },
    inviteJoinPerUser: { limit: 10, windowSec: 10 * 60 },
    inviteJoinPerIp: { limit: int('RATE_INVITE_PER_IP', 60), windowSec: 10 * 60 },
    // Per-session ceiling for everything else, kept in memory because it is only a politeness cap.
    apiPerUser: { limit: int('RATE_API_PER_USER', 600), windowSec: 60 },
  },

  board: {
    defaultPageSize: 24,
    maxPageSize: 50,
    countCacheMs: 5000,
  },

  suggestions: {
    candidatePool: 500,
    defaultLimit: 12,
    // Hours of the local day we assume a participant is reachable during a hackathon.
    activeWindow: { startHour: 9, endHour: 22 },
    weights: { wanted: 0.45, complementary: 0.3, timezone: 0.25 },
  },

  sse: {
    heartbeatMs: 25_000,
    maxStreamsPerUser: 6,
    maxBufferedBytes: 256 * 1024,
  },

  // Failpoints exist only so the chaos test can kill the process at an exact line.
  failpoint: env.NODE_ENV === 'test' ? (env.FAILPOINT ?? '') : '',
};

export const SKILLS = Object.freeze([
  'frontend',
  'backend',
  'fullstack',
  'mobile',
  'design',
  'ml',
  'data',
  'devops',
  'security',
  'blockchain',
  'hardware',
  'gamedev',
  'product',
  'pitching',
  'marketing',
  'research',
]);
