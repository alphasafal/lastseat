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

const leftovers = async () => ({
  users: await ctx.col.users().countDocuments({ lab: { $exists: true } }),
  teams: await ctx.col.teams().countDocuments(),
  participants: await ctx.col.participants().countDocuments(),
  invites: await ctx.col.invites().countDocuments(),
  audit: await ctx.col.audit().countDocuments(),
});
const NOTHING = { users: 0, teams: 0, participants: 0, invites: 0, audit: 0 };

describe('race lab', () => {
  test('50 contenders, 1 seat: one joins, 49 are told the team is full, every check passes', async () => {
    const res = await anon.post('/api/lab/race', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const run = res.body;

    assert.equal(run.contenders, 50);
    assert.equal(run.seats, 1);
    assert.equal(run.joined, 1);
    assert.equal(run.teamFull, 49);
    assert.equal(run.other, 0);
    assert.equal(run.passed, true);
    assert.equal(run.checks.length, 6);
    assert.deepEqual(
      run.checks.filter((check) => !check.ok),
      [],
    );

    assert.equal(run.results.length, 50);
    assert.equal(run.results.filter((result) => result.outcome === 'JOINED').length, 1);
    assert.deepEqual(
      [...run.results.map((result) => result.finishedAs)].sort((a, b) => a - b),
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    assert.ok(run.results.every((result) => result.attempts >= 1));
    assert.equal(
      run.retries,
      run.results.reduce((sum, r) => sum + r.attempts - 1, 0),
    );

    // The winner named in the response is the fourth member of the stored team.
    const winner = run.results.find((result) => result.outcome === 'JOINED');
    assert.equal(run.team.memberCount, 4);
    assert.equal(run.team.openSeats, 0);
    assert.equal(run.team.members.at(-1).name, winner.name);
  });

  test('3 seats, 20 contenders: exactly three join', async () => {
    const res = await anon.post('/api/lab/race', { contenders: 20, seats: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.body.joined, 3);
    assert.equal(res.body.teamFull, 17);
    assert.equal(res.body.passed, true);
  });

  test('a run deletes everything it created and never appears in listings', async () => {
    await anon.post('/api/lab/race', { contenders: 10 });
    assert.deepEqual(await leftovers(), NOTHING);

    const viewer = await ctx.user();
    const list = await viewer.get('/api/hackathons');
    assert.deepEqual(list.body.hackathons, [], 'the lab hackathon is hidden');
    await ctx.assertInvariants();
  });

  test('several runs at once do not disturb each other', async () => {
    const runs = await Promise.all(
      Array.from({ length: 3 }, () => anon.post('/api/lab/race', { contenders: 15 })),
    );
    for (const res of runs) {
      assert.equal(res.status, 200);
      assert.equal(res.body.joined, 1);
      assert.equal(res.body.passed, true);
    }
    assert.deepEqual(await leftovers(), NOTHING);
  });

  test('input is validated and runs are rate limited per address', async () => {
    assert.equal((await anon.post('/api/lab/race', { contenders: 1000 })).status, 400);
    assert.equal((await anon.post('/api/lab/race', { seats: 4 })).status, 400);
    assert.equal((await anon.post('/api/lab/race', { contenders: 5, drop: 'teams' })).status, 400);

    // Six runs so far in this file; rejected input does not count. The limit is 8 per ten
    // minutes, so two more go through and the ninth is refused.
    assert.equal((await anon.post('/api/lab/race', { contenders: 2 })).status, 200);
    assert.equal((await anon.post('/api/lab/race', { contenders: 2 })).status, 200);
    const blocked = await anon.post('/api/lab/race', { contenders: 5 });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});
