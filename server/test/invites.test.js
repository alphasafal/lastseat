import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

let ctx;
let hackathon;

before(async () => {
  ctx = await startTestServer();
  hackathon = await ctx.hackathon({ min: 2, max: 4 });
});
after(() => ctx.stop());

describe('invite codes', () => {
  test('a code has 60 bits of entropy and is stored only as a hash', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    assert.match(invite.code, /^[0-9A-HJKMNP-TV-Z]{12}$/, 'Crockford base32, 12 symbols');

    const stored = await ctx.col.invites().findOne({ _id: new ctx.ObjectId(invite.id) });
    assert.equal(stored.code, undefined);
    assert.ok(
      !JSON.stringify(stored).includes(invite.code),
      'plaintext code must not be in the row',
    );
    assert.match(stored.codeHash, /^[0-9a-f]{64}$/);

    // Listing invites never returns the code again, only a hint to tell them apart.
    const listed = await squad.leader.get(`/api/teams/${squad.id}/invites`);
    assert.equal(listed.body.invites[0].code, undefined);
    assert.equal(listed.body.invites[0].hint, invite.code.slice(-4));

    const many = new Set();
    for (let i = 0; i < 4; i += 1) many.add((await squad.invite()).code);
    assert.equal(many.size, 4);
  });

  test('joining with a code works however the code is typed', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    const typed =
      `  ${invite.code.slice(0, 4)}-${invite.code.slice(4, 8)} ${invite.code.slice(8)} `.toLowerCase();

    const user = await ctx.participant(hackathon, { name: 'Typist' });
    const res = await user.post('/api/invites/join', { code: typed });
    assert.equal(res.status, 200);
    assert.equal(res.body.team.memberCount, 2);
    assert.equal(res.body.me.teamId, squad.id);
    assert.equal(res.body.me.lookingForTeam, false);
  });

  test('an invite link registers a newcomer in the hackathon on the way in', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    const newcomer = await ctx.user({ name: 'Brand New' });
    const res = await newcomer.post('/api/invites/join', { code: invite.code });
    assert.equal(res.status, 200);
    assert.equal((await newcomer.get(`/api/hackathons/${hackathon.id}/me`)).body.team.id, squad.id);
  });

  test('only the leader can create, list or revoke codes', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    const member = await ctx.participant(hackathon);
    await member.post('/api/invites/join', { code: invite.code });

    for (const res of [
      await member.post(`/api/teams/${squad.id}/invites`),
      await member.get(`/api/teams/${squad.id}/invites`),
      await member.delete(`/api/teams/${squad.id}/invites/${invite.id}`),
    ]) {
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'NOT_TEAM_LEADER');
    }
  });

  test('expired, revoked and unknown codes are refused with one indistinguishable answer', async () => {
    const squad = await ctx.team(hackathon);
    const expired = await squad.invite();
    const revoked = await squad.invite();
    // Move the expiry into the past instead of sleeping: the server compares with its own clock.
    await ctx.col
      .invites()
      .updateOne(
        { _id: new ctx.ObjectId(expired.id) },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
    assert.equal(
      (await squad.leader.delete(`/api/teams/${squad.id}/invites/${revoked.id}`)).status,
      200,
    );
    // Revoking again is a harmless no-op.
    assert.equal(
      (await squad.leader.delete(`/api/teams/${squad.id}/invites/${revoked.id}`)).status,
      200,
    );

    const user = await ctx.participant(hackathon);
    const answers = [];
    for (const code of [expired.code, revoked.code, 'ZZZZZZZZZZZZ']) {
      const res = await user.post('/api/invites/join', { code });
      assert.equal(res.status, 404);
      answers.push(JSON.stringify(res.body));
    }
    assert.equal(new Set(answers).size, 1, 'a guesser must not learn which codes once existed');
    assert.equal((await squad.fetch()).memberCount, 1);
  });

  test('expiry must be between 5 minutes and 7 days', async () => {
    const squad = await ctx.team(hackathon);
    const post = (expiresInMinutes) =>
      squad.leader.post(`/api/teams/${squad.id}/invites`, { expiresInMinutes });
    assert.equal((await post(1)).status, 400);
    assert.equal((await post(7 * 24 * 60 + 1)).status, 400);
    const ok = await post(30);
    assert.equal(ok.status, 201);
    const ttlMs = new Date(ok.body.invite.expiresAt) - new Date(ok.body.invite.createdAt);
    assert.equal(ttlMs, 30 * 60_000);
  });

  test('a team can hold at most 5 active codes', async () => {
    const squad = await ctx.team(hackathon);
    for (let i = 0; i < 5; i += 1) await squad.invite();
    const sixth = await squad.leader.post(`/api/teams/${squad.id}/invites`);
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.error.code, 'TOO_MANY_INVITES');
  });

  test('guessing codes is cut off after 10 attempts, including malformed ones', async () => {
    const squad = await ctx.team(hackathon);
    const real = await squad.invite();
    const attacker = await ctx.participant(hackathon);

    const statuses = [];
    for (let i = 0; i < 10; i += 1) {
      const guess = i % 2 === 0 ? `AAAAAAAAAA${String(i).padStart(2, '0')}` : 'short';
      statuses.push((await attacker.post('/api/invites/join', { code: guess })).status);
    }
    assert.ok(statuses.every((status) => status === 404 || status === 400));

    // The 11th attempt is blocked even though this time the code is correct.
    const blocked = await attacker.post('/api/invites/join', { code: real.code });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await squad.fetch()).memberCount, 1);

    // Someone else is not affected by the attacker's lockout.
    const honest = await ctx.participant(hackathon);
    assert.equal((await honest.post('/api/invites/join', { code: real.code })).status, 200);
  });

  test('a code cannot pull someone out of the team they are already in', async () => {
    const [a, b] = [await ctx.team(hackathon), await ctx.team(hackathon)];
    const res = await a.leader.post('/api/invites/join', { code: (await b.invite()).code });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ALREADY_IN_TEAM');
    assert.equal((await b.fetch()).memberCount, 1);
    await ctx.assertInvariants();
  });
});
