import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { anonymous, startTestServer } from './helpers.js';

let ctx;
let anon;

before(async () => {
  ctx = await startTestServer();
  anon = anonymous(ctx.baseUrl);
});
after(() => ctx.stop());

const account = (email) => ({
  email,
  password: 'correct horse battery',
  name: 'Asha Rao',
  skills: ['frontend', 'design'],
  timezone: 'Asia/Kolkata',
});

function cookieFrom(res) {
  return res.headers.get('set-cookie').split(';')[0];
}

describe('authentication', () => {
  test('register sets an httpOnly session cookie and /me returns the user', async () => {
    const res = await anon.post('/api/auth/register', account('asha@example.com'));
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'asha@example.com');
    assert.equal(res.body.user.passwordHash, undefined, 'hash must never be serialized');

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    const me = await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { cookie: cookieFrom(res) } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.name, 'Asha Rao');
  });

  test('the same email cannot register twice, whatever its letter case', async () => {
    await anon.post('/api/auth/register', account('dup@example.com'));
    const res = await anon.post('/api/auth/register', account('DUP@example.com'));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_TAKEN');
  });

  test('wrong password and unknown email give the same answer', async () => {
    await anon.post('/api/auth/register', account('known@example.com'));
    const wrong = await anon.post('/api/auth/login', {
      email: 'known@example.com',
      password: 'nope-nope',
    });
    const unknown = await anon.post('/api/auth/login', {
      email: 'ghost@example.com',
      password: 'nope-nope',
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  test('login works and logout invalidates the session on the server', async () => {
    await anon.post('/api/auth/register', account('inout@example.com'));
    const login = await anon.post('/api/auth/login', {
      email: 'inout@example.com',
      password: 'correct horse battery',
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);

    const out = await fetch(`${ctx.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(out.status, 204);
    // Replaying the old cookie must not work: the session row is gone, not just the cookie.
    const me = await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 401);
  });

  test('registration input is validated field by field', async () => {
    const res = await anon.post('/api/auth/register', {
      email: 'not-an-email',
      password: 'short',
      name: 'A',
      skills: ['frontend', 'telepathy'],
      timezone: 'Mars/Olympus',
      isAdmin: true,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    const paths = res.body.error.issues.map((issue) => issue.path);
    for (const field of ['email', 'password', 'name', 'skills.1', 'timezone']) {
      assert.ok(paths.includes(field), `expected an issue for ${field}, got ${paths}`);
    }
    assert.ok(res.body.error.issues.some((issue) => /unrecognized/i.test(issue.message)));
  });

  test('every API route except auth requires a session', async () => {
    for (const path of ['/api/hackathons', '/api/teams/000000000000000000000000', '/api/stream']) {
      const res = await anon.get(path);
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    }
  });

  test('a cross-origin POST is refused even with a valid cookie', async () => {
    const user = await ctx.user();
    const res = await user.post('/api/auth/logout', {}, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CROSS_ORIGIN');
    assert.equal((await user.get('/api/auth/me')).status, 200, 'session must still be alive');
  });

  test('login attempts for one email are rate limited', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await anon.post('/api/auth/login', {
        email: 'target@example.com',
        password: `guess-${i}`,
      });
      statuses.push(res.status);
      if (res.status === 429) assert.ok(Number(res.headers.get('retry-after')) > 0);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.deepEqual(statuses.slice(10), [429, 429]);
  });
});
