import { MongoClient, MongoError, ObjectId } from 'mongodb';
import { config } from './config.js';
import { errors } from './lib/errors.js';
import { metrics } from './lib/metrics.js';

/** @type {MongoClient} */
let client;
/** @type {import('mongodb').Db} */
let database;

export const INDEX = {
  memberPerHackathon: 'uniq_member_per_hackathon',
  teamName: 'uniq_team_name_per_hackathon',
  pendingRequest: 'uniq_pending_request_per_team_user',
  participant: 'uniq_participant_per_hackathon',
  email: 'uniq_email',
  inviteCode: 'uniq_invite_code_hash',
};

export async function connect(uri = config.mongoUri) {
  client = new MongoClient(uri, {
    maxPoolSize: config.mongoMaxPool,
    // The driver opens two connections at a time by default. A burst on a cold pool (50
    // people redeeming one code just after a deploy) would queue behind 25 rounds of TLS
    // handshakes, so let the pool grow faster.
    maxConnecting: 8,
    // Majority writes + snapshot reads are what make a committed join survive a crash.
    writeConcern: { w: 'majority' },
    retryWrites: true,
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  // A connection string without a database name (hosted providers often hand those out)
  // would silently use "test"; fall back to a database named after the app instead.
  const named = /^mongodb(?:\+srv)?:\/\/[^/]+\/[^?]+/.test(uri);
  database = named ? client.db() : client.db('lastseat');
  return database;
}

export async function disconnect() {
  await client?.close();
}

export const db = () => database;
export const mongoClient = () => client;

export const col = {
  users: () => database.collection('users'),
  sessions: () => database.collection('sessions'),
  hackathons: () => database.collection('hackathons'),
  participants: () => database.collection('participants'),
  teams: () => database.collection('teams'),
  invites: () => database.collection('invites'),
  joinRequests: () => database.collection('join_requests'),
  audit: () => database.collection('audit_log'),
  idempotency: () => database.collection('idempotency_keys'),
  rateLimits: () => database.collection('rate_limits'),
};

/**
 * The indexes are part of the design, not an optimization: the two unique indexes on `teams`
 * are what make "one team per person" impossible to violate, whatever the application does.
 */
export async function ensureIndexes() {
  await Promise.all([
    col.users().createIndex({ email: 1 }, { unique: true, name: INDEX.email }),

    col.sessions().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    col.hackathons().createIndex({ slug: 1 }, { unique: true }),

    col
      .participants()
      .createIndex({ hackathonId: 1, userId: 1 }, { unique: true, name: INDEX.participant }),
    // People board: only participants who are looking are in the index at all.
    col
      .participants()
      .createIndex(
        { hackathonId: 1, updatedAt: -1, _id: -1 },
        { name: 'board_people', partialFilterExpression: { lookingForTeam: true } },
      ),
    col
      .participants()
      .createIndex(
        { hackathonId: 1, skills: 1, updatedAt: -1, _id: -1 },
        { name: 'board_people_by_skill', partialFilterExpression: { lookingForTeam: true } },
      ),

    // INVARIANT: a user appears in at most one team per hackathon.
    // A unique multikey index has one entry per (hackathonId, member), so a second team
    // containing the same user cannot be written - by a join, a create, or a bug.
    col
      .teams()
      .createIndex(
        { hackathonId: 1, 'members.userId': 1 },
        { unique: true, name: INDEX.memberPerHackathon },
      ),
    col.teams().createIndex({ hackathonId: 1, nameKey: 1 }, { unique: true, name: INDEX.teamName }),
    // Teams board: a full team drops out of this index the moment its last seat is taken.
    col
      .teams()
      .createIndex(
        { hackathonId: 1, updatedAt: -1, _id: -1 },
        { name: 'board_teams', partialFilterExpression: { openSeats: { $gt: 0 } } },
      ),
    col
      .teams()
      .createIndex(
        { hackathonId: 1, lookingFor: 1, updatedAt: -1, _id: -1 },
        { name: 'board_teams_by_skill', partialFilterExpression: { openSeats: { $gt: 0 } } },
      ),

    col.invites().createIndex({ codeHash: 1 }, { unique: true, name: INDEX.inviteCode }),
    col.invites().createIndex({ teamId: 1, expiresAt: -1 }),
    // Expired codes are kept for a week for the audit trail, then removed.
    col.invites().createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),

    col.joinRequests().createIndex(
      { teamId: 1, userId: 1 },
      {
        unique: true,
        name: INDEX.pendingRequest,
        partialFilterExpression: { status: 'pending' },
      },
    ),
    col.joinRequests().createIndex({ teamId: 1, status: 1, createdAt: -1 }),
    col.joinRequests().createIndex({ hackathonId: 1, userId: 1, status: 1, createdAt: -1 }),

    col.audit().createIndex({ teamId: 1, _id: -1 }),
    col.audit().createIndex({ hackathonId: 1, _id: -1 }),

    col.idempotency().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    col.rateLimits().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` in a transaction. The driver re-invokes the callback when MongoDB reports a
 * transient error, which is exactly what happens to the losers of a race: two transactions
 * touched the same team document, one commits, the other gets a WriteConflict, is rolled back
 * and runs again against the new state.
 *
 * `work` must therefore be safe to run more than once and must only talk to the database
 * through the session it is given.
 *
 * Retrying is bounded by config.txnDeadlineMs. The case that needs it: a server instance is
 * killed in the middle of a transaction. MongoDB rolls that transaction back, but only when
 * its lifetime limit expires (60 s by default), and until then the documents it touched
 * reject other writers. Those writers get a 503 they can retry instead of a hung request.
 *
 * @template T
 * @param {(session: import('mongodb').ClientSession) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withTransaction(work) {
  const session = client.startSession();
  const startedAt = Date.now();
  let attempt = 0;
  try {
    const result = await session.withTransaction(
      async () => {
        attempt += 1;
        // Hooks registered by an attempt that was rolled back must not survive it.
        commitHooks.set(session, []);
        if (attempt > 1) {
          metrics.txnRetries.inc();
          if (Date.now() - startedAt > config.txnDeadlineMs) throw errors.busy();
          // Jittered backoff so 49 losers do not all retry in the same millisecond. A retry
          // that arrives before the winner has committed only conflicts again, so the wait
          // grows quickly: up to 40 ms, 80 ms, 160 ms, then 250 ms.
          await sleep(Math.random() * Math.min(10 * 2 ** attempt, 250));
        }
        return work(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    for (const hook of commitHooks.get(session) ?? []) hook();
    return result;
  } finally {
    await session.endSession();
  }
}

const commitHooks = new WeakMap();

/**
 * Registers a side effect that runs only if the surrounding transaction commits, and only
 * once however many times the transaction was retried.
 */
export function onCommit(session, hook) {
  commitHooks.get(session)?.push(hook);
}

/**
 * Thrown inside a transaction to make the driver run it again from the top. Used when the
 * transaction can tell that its snapshot is already out of date (for example a row it was
 * about to create has just been created by someone else).
 */
export function retryTransaction(reason) {
  const err = new MongoError(reason);
  err.addErrorLabel('TransientTransactionError');
  return err;
}

export function toObjectId(value) {
  return value instanceof ObjectId ? value : new ObjectId(String(value));
}

export { ObjectId };
