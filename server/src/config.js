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
  mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lastseat?directConnection=true',
  trustProxy: int('TRUST_PROXY', 0),
  // Connections per server instance. Keep it small on serverless, where instances multiply.
  mongoMaxPool: int('MONGO_MAX_POOL', 100),
  metricsToken: env.METRICS_TOKEN ?? '',
  // Serverless hosts suspend the process between requests. After a pause longer than this the
  // database connections are replaced before the next request is served. 0 = never.
  reconnectAfterPauseMs: int('RECONNECT_AFTER_PAUSE_MS', 0),
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),

  // A transaction that keeps losing races gives up after this long and the client is told
  // to retry, instead of holding a request open indefinitely.
  txnDeadlineMs: int('TXN_DEADLINE_MS', 8000),

  session: {
    cookieName: 'sid',
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    // Secure cookies are only sent over HTTPS. On by default in production; Docker Compose
    // turns it off because it serves plain http://localhost.
    secureCookie: (env.COOKIE_SECURE ?? String(env.NODE_ENV === 'production')) === 'true',
    // How long a verified session is trusted without asking the database again.
    cacheMs: int('SESSION_CACHE_MS', 10_000),
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
    // The public race lab creates and deletes ~55 documents per run.
    labPerIp: { limit: int('RATE_LAB_PER_IP', 8), windowSec: 10 * 60 },
    labGlobal: { limit: 40, windowSec: 60 },
    // Per-session ceiling for everything else, kept in memory because it is only a politeness cap.
    apiPerUser: { limit: int('RATE_API_PER_USER', 600), windowSec: 60 },
  },

  lab: {
    // Shown under a race result. Lets a deployment say something true about its own database,
    // for example that a free shared cluster rate-limits operations.
    note: env.LAB_NOTE ?? '',
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
    // Hosts that cap request duration (serverless) cut a stream without warning. Ending it
    // ourselves a little earlier lets the browser reconnect cleanly. 0 = never.
    maxStreamMs: int('SSE_MAX_STREAM_MS', 0),
    // Some hosts bill for every second a connection is open. The page is then told to let go
    // of its stream after this long without any input, and to reopen it on the next. 0 = never.
    idlePauseMs: int('SSE_IDLE_PAUSE_MS', 0),
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
