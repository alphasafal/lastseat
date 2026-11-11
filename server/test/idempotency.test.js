import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { idempotencyKey, startTestServer } from './helpers.js';

let ctx;
let hackathon;

before(async () => {
  ctx = await startTestServer();
  hackathon = await ctx.hackathon({ min: 2, max: 4 });
});
after(() => ctx.stop());

describe('idempotency', () => {
  test('a retried create returns the original response and creates nothing new', async () => {
    const user = await ctx.participant(hackathon);
    const key = idempotencyKey();
    const body = { name: 'Retry Safe' };

    const first = await user.post(`/api/hackathons/${hackathon.id}/teams`, body, key);
    const retry = await user.post(`/api/hackathons/${hackathon.id}/teams`, body, key);

    assert.equal(first.status, 201);
    assert.equal(retry.status, 201, 'the retry sees the same success, not ALREADY_IN_TEAM');
    assert.deepEqual(retry.body, first.body);
    assert.equal(first.headers.get('idempotent-replayed'), null);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal(await ctx.col.teams().countDocuments({ nameKey: 'retry safe' }), 1);
    const audit = await ctx.col
      .audit()
      .countDocuments({ type: 'team.created', 'data.name': 'Retry Safe' });
    assert.equal(audit, 1, 'the replay must not write a second audit entry');
  });

  test('a double click (same key, same instant) creates exactly one team', async () => {
    const user = await ctx.participant(hackathon);
    const key = idempotencyKey();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        user.post(`/api/hackathons/${hackathon.id}/teams`, { name: 'Double Click' }, key),
      ),
    );
    assert.ok(
      results.every((res) => res.status === 201),
      'every copy gets the success response',
    );
    assert.equal(new Set(results.map((res) => res.body.team.id)).size, 1);
    assert.equal(results.filter((res) => !res.headers.get('idempotent-replayed')).length, 1);
    assert.equal(await ctx.col.teams().countDocuments({ nameKey: 'double click' }), 1);
  });

  test('retrying a join never adds the person twice, with or without a key', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    const user = await ctx.participant(hackathon);
    const key = idempotencyKey();

    // Eight copies, not more: every attempt counts towards the 10-per-10-minutes guess limit.
    const burst = await Promise.all(
      Array.from({ length: 8 }, () => user.post('/api/invites/join', { code: invite.code }, key)),
    );
    assert.ok(burst.every((res) => res.status === 200));

    // A later retry without any key is still harmless: joining is naturally idempotent.
    const plain = await user.post('/api/invites/join', { code: invite.code });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.alreadyMember, true);

    const team = await squad.fetch();
    assert.equal(team.memberCount, 2);
    assert.equal(team.members.filter((member) => member.userId === user.id).length, 1);
    const joins = await ctx.col
      .audit()
      .countDocuments({ type: 'member.joined', subjectId: user._id });
    assert.equal(joins, 1);
    await ctx.assertInvariants();
  });

  test('reusing a key for a different request is rejected', async () => {
    const user = await ctx.participant(hackathon);
    const key = idempotencyKey();
    assert.equal(
      (await user.post(`/api/hackathons/${hackathon.id}/teams`, { name: 'Original' }, key)).status,
      201,
    );
    const other = await user.post(
      `/api/hackathons/${hackathon.id}/teams`,
      { name: 'Different' },
      key,
    );
    assert.equal(other.status, 422);
    assert.equal(other.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  test('keys are scoped to the user who sent them', async () => {
    const key = idempotencyKey();
    const [a, b] = [await ctx.participant(hackathon), await ctx.participant(hackathon)];
    const first = await a.post(`/api/hackathons/${hackathon.id}/teams`, { name: 'Team Of A' }, key);
    const second = await b.post(
      `/api/hackathons/${hackathon.id}/teams`,
      { name: 'Team Of B' },
      key,
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.team.id, second.body.team.id);
  });

  test('a failed request is not remembered: fixing the problem and retrying succeeds', async () => {
    const squad = await ctx.team(hackathon);
    const { invite } = await ctx.fillTeam(hackathon, squad, 0);
    const user = await ctx.participant(hackathon);
    const key = idempotencyKey();

    const full = await user.post('/api/invites/join', { code: invite.code }, key);
    assert.equal(full.body.error.code, 'TEAM_FULL');

    const members = (await squad.fetch()).members;
    await squad.leader.delete(`/api/teams/${squad.id}/members/${members.at(-1).userId}`);
    const retry = await user.post('/api/invites/join', { code: invite.code }, key);
    assert.equal(retry.status, 200);
  });

  test('a malformed key is refused', async () => {
    const user = await ctx.participant(hackathon);
    const res = await user.post(
      `/api/hackathons/${hackathon.id}/teams`,
      { name: 'Bad Key' },
      { 'Idempotency-Key': 'a b' },
    );
    assert.equal(res.status, 400);
  });
});
