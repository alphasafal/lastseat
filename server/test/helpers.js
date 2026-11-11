// Test harness: every test file gets its own database and its own server on a random port,
// and talks to it over real HTTP with real cookies. Nothing is mocked - the point of these
// tests is the behaviour of the actual MongoDB operations.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
// All test traffic comes from 127.0.0.1, so the per-IP caps are lifted; the per-user caps,
// which are what stop invite-code guessing, stay at their production values.
process.env.RATE_INVITE_PER_IP ??= '1000000';
process.env.RATE_AUTH_PER_IP ??= '1000000';
const BASE_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';

export async function startTestServer() {
  const dbName = `lastseat_test_${randomBytes(5).toString('hex')}`;
  const uri = new URL(BASE_URI);
  uri.pathname = `/${dbName}`;
  process.env.MONGODB_URI = uri.toString();

  const { connect, disconnect, ensureIndexes, db, col, ObjectId } = await import('../src/db.js');
  const { createApp } = await import('../src/app.js');
  const { startChangeStream, stopChangeStream } = await import('../src/realtime/changeStream.js');
  const { closeAll } = await import('../src/realtime/hub.js');
  const { checkInvariants } = await import('../src/lib/invariants.js');

  await connect(uri.toString());
  await ensureIndexes();
  await startChangeStream();

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let userCounter = 0;

  const ctx = {
    baseUrl,
    db,
    col,
    ObjectId,

    /** Creates a hackathon directly in the database. */
    async hackathon({ min = 2, max = 4 } = {}) {
      const doc = {
        _id: new ObjectId(),
        slug: `h-${randomBytes(4).toString('hex')}`,
        name: 'Test Hackathon',
        tagline: '',
        minTeamSize: min,
        maxTeamSize: max,
        startsAt: new Date(),
        createdAt: new Date(),
      };
      await col.hackathons().insertOne(doc);
      return { id: String(doc._id), _id: doc._id };
    },

    /**
     * Creates a signed-in user without paying for password hashing: the user and session rows
     * are written directly. Returns an HTTP client bound to that user's cookie.
     */
    async user({ name, skills = ['backend'], timezone = 'Asia/Kolkata', role } = {}) {
      userCounter += 1;
      const _id = new ObjectId();
      const user = {
        _id,
        email: `u${userCounter}-${randomBytes(3).toString('hex')}@test.local`,
        name: name ?? `User ${userCounter}`,
        skills,
        timezone,
        passwordHash: 'unused',
        ...(role ? { role } : {}),
        createdAt: new Date(),
      };
      await col.users().insertOne(user);
      const token = randomBytes(32).toString('base64url');
      await col.sessions().insertOne({
        _id: createHash('sha256').update(token).digest('hex'),
        userId: _id,
        name: user.name,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return client(baseUrl, { id: String(_id), _id, name: user.name, cookie: `sid=${token}` });
    },

    /** A user who is already registered in the hackathon. */
    async participant(hackathon, options) {
      const user = await ctx.user(options);
      const res = await user.post(`/api/hackathons/${hackathon.id}/participants`);
      assert.equal(res.status, 200);
      return user;
    },

    /** A leader with a team, plus a helper to mint invite codes. */
    async team(hackathon, { name, leader, lookingFor = [] } = {}) {
      const owner = leader ?? (await ctx.participant(hackathon));
      const res = await owner.post(`/api/hackathons/${hackathon.id}/teams`, {
        name: name ?? `Team ${randomBytes(3).toString('hex')}`,
        lookingFor,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const team = res.body.team;
      return {
        leader: owner,
        id: team.id,
        team,
        async invite(expiresInMinutes) {
          const created = await owner.post(
            `/api/teams/${team.id}/invites`,
            expiresInMinutes ? { expiresInMinutes } : {},
          );
          assert.equal(created.status, 201, JSON.stringify(created.body));
          return created.body.invite;
        },
        async fetch() {
          return (await owner.get(`/api/teams/${team.id}`)).body.team;
        },
      };
    },

    /** Fills a team until `openSeats` seats are left. */
    async fillTeam(hackathon, squad, openSeats) {
      const invite = await squad.invite();
      let current = await squad.fetch();
      while (current.openSeats > openSeats) {
        const member = await ctx.participant(hackathon);
        const res = await member.post('/api/invites/join', { code: invite.code });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        current = res.body.team;
      }
      return { invite, team: current };
    },

    async invariants() {
      return checkInvariants(db());
    },

    async assertInvariants() {
      const report = await checkInvariants(db());
      assert.deepEqual(report.violations, []);
      return report;
    },

    async stop() {
      closeAll();
      await stopChangeStream();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await db().dropDatabase();
      await disconnect();
    },
  };
  return ctx;
}

function client(baseUrl, identity) {
  async function request(method, path, body, headers = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        cookie: identity.cookie,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  return {
    ...identity,
    get: (path, headers) => request('GET', path, undefined, headers),
    post: (path, body = {}, headers) => request('POST', path, body, headers),
    patch: (path, body, headers) => request('PATCH', path, body, headers),
    put: (path, body, headers) => request('PUT', path, body, headers),
    delete: (path, headers) => request('DELETE', path, undefined, headers),
    /** Opens the SSE stream and collects parsed events. */
    async stream(query) {
      return openStream(`${baseUrl}/api/stream?${new URLSearchParams(query)}`, identity.cookie);
    },
  };
}

export const anonymous = (baseUrl) => client(baseUrl, { cookie: '' });
export const idempotencyKey = () => ({ 'Idempotency-Key': randomUUID() });

async function openStream(url, cookie) {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { cookie }, signal: controller.signal });
  const events = [];
  const waiters = [];
  const decoder = new TextDecoder();
  let buffer = '';

  (async () => {
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = { event: 'message', data: null };
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event.event = line.slice(7);
            if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
          }
          if (frame.startsWith(':') || frame.startsWith('retry')) continue;
          events.push(event);
          for (const waiter of [...waiters]) waiter();
        }
      }
    } catch {
      // aborted by close()
    }
  })();

  return {
    status: res.status,
    events,
    /** Resolves with the first event matching `predicate`, or rejects after `timeoutMs`. */
    waitFor(predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = events.find(predicate);
          if (!found) return false;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`no matching event within ${timeoutMs} ms; saw ${events.map((e) => e.data?.type ?? e.event).join(', ')}`));
        }, timeoutMs);
        if (!check()) waiters.push(check);
      });
    },
    close: () => controller.abort(),
  };
}
