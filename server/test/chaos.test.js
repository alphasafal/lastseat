// Chaos test: kill the server process in the middle of a join and show that nothing is
// corrupted and nothing is lost.
//
// The server under attack runs as a separate OS process so it can be killed with SIGKILL
// (no cleanup handlers run - the same as a crashed container or an OOM kill). The test then
// inspects MongoDB directly and retries the interrupted requests against a healthy server.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// How long the healthy server retries a blocked transaction before answering 503 BUSY.
process.env.TXN_DEADLINE_MS = '1000';
const { startTestServer } = await import('./helpers.js');

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ctx;
let hackathon;
let admin;
let previousLifetime;

before(async () => {
  ctx = await startTestServer();
  hackathon = await ctx.hackathon({ min: 2, max: 4 });
  // A transaction whose client died is rolled back by MongoDB when its lifetime limit
  // expires. The default is 60 s; shorten it so the test does not have to wait a minute.
  admin = ctx.db().admin();
  const current = await admin.command({ getParameter: 1, transactionLifetimeLimitSeconds: 1 });
  previousLifetime = current.transactionLifetimeLimitSeconds;
  await admin.command({ setParameter: 1, transactionLifetimeLimitSeconds: 4 });
});

after(async () => {
  await admin.command({ setParameter: 1, transactionLifetimeLimitSeconds: previousLifetime });
  await ctx.stop();
});

async function freePort() {
  const probe = createServer().listen(0);
  await new Promise((resolve) => probe.once('listening', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Starts a second server process against the same database, optionally with a failpoint. */
async function spawnVictim(failpoint = '') {
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port), FAILPOINT: failpoint, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return { child, baseUrl, exited };
    } catch {
      await sleep(100);
    }
  }
  throw new Error('victim server did not start');
}

function joinVia(baseUrl, user, code, key) {
  return fetch(`${baseUrl}/api/invites/join`, {
    method: 'POST',
    headers: { cookie: user.cookie, 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ code }),
  });
}

/** Retries against the healthy server until MongoDB has released the orphaned transaction. */
async function retryUntilSettled(user, code, key) {
  const seen = [];
  for (let i = 0; i < 40; i += 1) {
    const res = await user.post('/api/invites/join', { code }, { 'Idempotency-Key': key });
    seen.push(res.status);
    if (res.status !== 503) return { res, seen };
    assert.equal(res.body.error.code, 'BUSY');
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    await sleep(500);
  }
  throw new Error(`still busy after retries: ${seen}`);
}

async function snapshot(teamId) {
  const _id = new ctx.ObjectId(teamId);
  return {
    team: await ctx.col.teams().findOne({ _id }),
    seated: await ctx.col.participants().countDocuments({ teamId: _id }),
    audit: await ctx.col.audit().countDocuments({ teamId: _id }),
  };
}

describe('chaos: SIGKILL in the middle of a join', () => {
  for (const failpoint of ['after-seat-claim', 'before-commit']) {
    test(`killed ${failpoint}: no partial join, and the retry succeeds exactly once`, async () => {
      const squad = await ctx.team(hackathon);
      const { invite } = await ctx.fillTeam(hackathon, squad, 1);
      const bystanders = await ctx.team(hackathon);
      const bystanderInvite = await bystanders.invite();
      const user = await ctx.participant(hackathon);
      const key = randomUUID();
      const before = await snapshot(squad.id);

      const victim = await spawnVictim(failpoint);
      await assert.rejects(
        joinVia(victim.baseUrl, user, invite.code, key),
        'the connection must drop',
      );
      assert.equal((await victim.exited).signal, 'SIGKILL');

      // 1. Nothing of the interrupted join is visible: not the seat, not the membership,
      //    not the audit entry, not the idempotency record.
      const afterKill = await snapshot(squad.id);
      assert.equal(afterKill.team.openSeats, 1);
      assert.equal(afterKill.team.version, before.team.version);
      assert.ok(!afterKill.team.members.some((member) => String(member.userId) === user.id));
      assert.equal(afterKill.seated, before.seated);
      assert.equal(afterKill.audit, before.audit);
      assert.equal(await ctx.col.idempotency().countDocuments({ _id: `${user.id}:${key}` }), 0);
      assert.equal((await user.get(`/api/hackathons/${hackathon.id}/me`)).body.me.teamId, null);
      await ctx.assertInvariants();

      // 2. Other teams are not affected at all while the dead transaction lingers.
      const other = await ctx.participant(hackathon);
      assert.equal(
        (await other.post('/api/invites/join', { code: bystanderInvite.code })).status,
        200,
      );

      // 3. The client retries with the same key. Until MongoDB reaps the orphaned transaction
      //    the answer is a retryable 503 - never a hang, never a wrong result. Then it succeeds.
      const { res, seen } = await retryUntilSettled(user, invite.code, key);
      assert.equal(res.status, 200, `statuses seen: ${seen}`);
      assert.equal(res.body.team.openSeats, 0);

      // 4. One more retry is answered from the stored result; the person is in the team once.
      const replay = await user.post(
        '/api/invites/join',
        { code: invite.code },
        { 'Idempotency-Key': key },
      );
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');
      const final = await snapshot(squad.id);
      assert.equal(
        final.team.members.filter((member) => String(member.userId) === user.id).length,
        1,
      );
      assert.equal(final.audit, before.audit + 1);
      await ctx.assertInvariants();
    });
  }

  test('killed at a random moment under 30 concurrent joins: seats are neither lost nor oversold', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite(); // 3 open seats
    const users = await Promise.all(Array.from({ length: 30 }, () => ctx.participant(hackathon)));
    const keys = users.map(() => randomUUID());

    const victim = await spawnVictim();
    const inFlight = users.map((user, i) =>
      joinVia(victim.baseUrl, user, invite.code, keys[i]).then(
        (res) => res.status,
        () => 'dropped',
      ),
    );
    await sleep(5 + Math.random() * 60);
    victim.child.kill('SIGKILL');
    const firstRound = await Promise.all(inFlight);
    await victim.exited;

    // Whatever instant the kill landed on, the stored state is consistent.
    const afterKill = await ctx.assertInvariants();
    const mid = await snapshot(squad.id);
    assert.ok(mid.team.memberCount >= 1 && mid.team.memberCount <= 4);
    assert.equal(mid.seated, mid.team.memberCount);

    // Every client that got no answer (or an error) retries with its original key.
    const settled = await Promise.all(
      users.map((user, i) => retryUntilSettled(user, invite.code, keys[i]).then(({ res }) => res)),
    );
    const joined = settled.filter((res) => res.status === 200);
    const full = settled.filter((res) => res.body?.error?.code === 'TEAM_FULL');
    assert.equal(joined.length, 3, 'exactly the three open seats are filled');
    assert.equal(full.length, 27);

    // A join that was acknowledged before the crash is still there after it (durability).
    firstRound.forEach((status, i) => {
      if (status === 200) assert.equal(settled[i].status, 200, 'an acknowledged join must survive');
    });

    const final = await snapshot(squad.id);
    assert.equal(final.team.memberCount, 4);
    assert.equal(final.team.openSeats, 0);
    assert.equal(new Set(final.team.members.map((member) => String(member.userId))).size, 4);
    const report = await ctx.assertInvariants();
    assert.ok(report.stats.teams >= afterKill.stats.teams);
  });
});
