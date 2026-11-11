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

async function join(user, invite) {
  const res = await user.post('/api/invites/join', { code: invite.code });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.team;
}

describe('team rules', () => {
  test('creating a team makes the creator its leader and only member', async () => {
    const leader = await ctx.participant(hackathon, {
      name: 'Lead',
      skills: ['backend', 'devops'],
    });
    const res = await leader.post(`/api/hackathons/${hackathon.id}/teams`, {
      name: 'Night Owls',
      description: 'Shipping at 3am',
      lookingFor: ['design', 'design', 'frontend'],
    });
    assert.equal(res.status, 201);
    const { team } = res.body;
    assert.equal(team.leaderId, leader.id);
    assert.equal(team.memberCount, 1);
    assert.equal(team.openSeats, 3);
    assert.equal(team.status, 'forming');
    assert.deepEqual(team.lookingFor, ['design', 'frontend'], 'duplicates are removed');
    assert.deepEqual(team.members[0].skills, ['backend', 'devops']);
    assert.equal(res.body.me.lookingForTeam, false);
  });

  test('you must be registered in the hackathon to create a team', async () => {
    const outsider = await ctx.user();
    const res = await outsider.post(`/api/hackathons/${hackathon.id}/teams`, {
      name: 'Gatecrashers',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NOT_REGISTERED');
  });

  test('one team per person per hackathon, but a second hackathon is fine', async () => {
    const squad = await ctx.team(hackathon);
    const again = await squad.leader.post(`/api/hackathons/${hackathon.id}/teams`, {
      name: 'Second Try',
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_IN_TEAM');

    const other = await ctx.hackathon();
    await squad.leader.post(`/api/hackathons/${other.id}/participants`);
    const elsewhere = await squad.leader.post(`/api/hackathons/${other.id}/teams`, {
      name: 'Second Try',
    });
    assert.equal(elsewhere.status, 201);
  });

  test('team names are unique per hackathon regardless of case', async () => {
    await ctx.team(hackathon, { name: 'Quantum Cats' });
    const user = await ctx.participant(hackathon);
    const res = await user.post(`/api/hackathons/${hackathon.id}/teams`, { name: 'quantum CATS' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TEAM_NAME_TAKEN');
    assert.equal((await user.get(`/api/hackathons/${hackathon.id}/me`)).body.me.teamId, null);
  });

  test('status follows the size rules: forming below the minimum, ready, then full', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    assert.equal((await squad.fetch()).status, 'forming');

    const seen = [];
    for (let i = 0; i < 3; i += 1)
      seen.push((await join(await ctx.participant(hackathon), invite)).status);
    assert.deepEqual(seen, ['ready', 'ready', 'full']);

    const late = await (
      await ctx.participant(hackathon)
    ).post('/api/invites/join', { code: invite.code });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'TEAM_FULL');
  });

  test('when the leader leaves, leadership passes to the longest-standing member', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    const first = await ctx.participant(hackathon, { name: 'First In' });
    const second = await ctx.participant(hackathon, { name: 'Second In' });
    await join(first, invite);
    await join(second, invite);

    const res = await squad.leader.post(`/api/teams/${squad.id}/leave`);
    assert.equal(res.status, 200);
    assert.equal(res.body.teamDeleted, false);
    assert.equal(res.body.team.leaderId, first.id);
    assert.equal(res.body.team.memberCount, 2);
    assert.equal(res.body.me.lookingForTeam, true, 'the person who left is back on the board');

    // The new leader really has the leader's powers, and the old one has none.
    assert.equal((await first.post(`/api/teams/${squad.id}/invites`)).status, 201);
    assert.equal((await squad.leader.post(`/api/teams/${squad.id}/invites`)).status, 403);
  });

  test('the last member leaving deletes the team and closes its invites and requests', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    const applicant = await ctx.participant(hackathon);
    const request = await applicant.post(`/api/teams/${squad.id}/requests`, { message: 'pick me' });
    assert.equal(request.status, 201);

    const res = await squad.leader.post(`/api/teams/${squad.id}/leave`);
    assert.equal(res.status, 200);
    assert.equal(res.body.teamDeleted, true);
    assert.equal(res.body.team, null);

    assert.equal((await squad.leader.get(`/api/teams/${squad.id}`)).status, 404);
    const viaCode = await applicant.post('/api/invites/join', { code: invite.code });
    assert.equal(viaCode.body.error.code, 'INVITE_INVALID');
    const mine = await applicant.get(`/api/hackathons/${hackathon.id}/requests/mine`);
    assert.equal(mine.body.requests[0].status, 'cancelled');
    assert.equal(mine.body.requests[0].reason, 'team_deleted');

    // The name is free again and the former leader can start over.
    const reborn = await squad.leader.post(`/api/hackathons/${hackathon.id}/teams`, {
      name: squad.team.name,
    });
    assert.equal(reborn.status, 201);
  });

  test('only the leader can remove a member, and not themselves', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    const a = await ctx.participant(hackathon);
    const b = await ctx.participant(hackathon);
    await join(a, invite);
    await join(b, invite);

    const byMember = await a.delete(`/api/teams/${squad.id}/members/${b.id}`);
    assert.equal(byMember.status, 403);
    assert.equal(byMember.body.error.code, 'NOT_TEAM_LEADER');

    const self = await squad.leader.delete(`/api/teams/${squad.id}/members/${squad.leader.id}`);
    assert.equal(self.status, 400);

    const ok = await squad.leader.delete(`/api/teams/${squad.id}/members/${b.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.team.memberCount, 2);
    assert.ok(!ok.body.team.members.some((member) => member.userId === b.id));
    assert.equal((await b.get(`/api/hackathons/${hackathon.id}/me`)).body.me.teamId, null);

    const twice = await squad.leader.delete(`/api/teams/${squad.id}/members/${b.id}`);
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'NOT_A_MEMBER');
  });

  test('leadership can be handed to a member, and only by the current leader', async () => {
    const squad = await ctx.team(hackathon);
    const member = await ctx.participant(hackathon);
    await join(member, await squad.invite());
    const stranger = await ctx.participant(hackathon);

    assert.equal(
      (await member.put(`/api/teams/${squad.id}/leader`, { userId: member.id })).status,
      403,
    );
    const toStranger = await squad.leader.put(`/api/teams/${squad.id}/leader`, {
      userId: stranger.id,
    });
    assert.equal(toStranger.body.error.code, 'NOT_A_MEMBER');

    const ok = await squad.leader.put(`/api/teams/${squad.id}/leader`, { userId: member.id });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.team.leaderId, member.id);
    assert.equal(ok.body.team.memberCount, 2, 'the old leader stays on as a member');
  });

  test('only the leader can edit the team', async () => {
    const squad = await ctx.team(hackathon);
    const member = await ctx.participant(hackathon);
    await join(member, await squad.invite());

    const denied = await member.patch(`/api/teams/${squad.id}`, { description: 'mine now' });
    assert.equal(denied.status, 403);

    const ok = await squad.leader.patch(`/api/teams/${squad.id}`, {
      description: 'We build tools for farmers',
      lookingFor: ['ml'],
      acceptingRequests: false,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.team.acceptingRequests, false);
    assert.equal(ok.body.team.version, squad.team.version + 2);
  });

  test('ids, bodies and unknown fields are validated before anything runs', async () => {
    const user = await ctx.participant(hackathon);
    const base = `/api/hackathons/${hackathon.id}/teams`;
    const cases = [
      [await user.get('/api/teams/not-an-id'), 400],
      [await user.post(base, { name: 'ab' }), 400],
      [await user.post(base, { name: 'x'.repeat(41) }), 400],
      [await user.post(base, { name: 'Valid Name', lookingFor: ['wizardry'] }), 400],
      [await user.post(base, { name: 'Valid Name', leaderId: user.id }), 400],
      [await user.post(base, { name: 'Line\nBreak' }), 400],
      // Operators in place of strings are how NoSQL injection is attempted.
      [await user.post(base, { name: { $ne: null } }), 400],
      [await user.post('/api/invites/join', { code: { $gt: '' } }), 400],
      [await user.get(`/api/teams/000000000000000000000000`), 404],
    ];
    for (const [res, expected] of cases)
      assert.equal(res.status, expected, JSON.stringify(res.body));

    const tooBig = await user.post(base, { name: 'Big', description: 'x'.repeat(20_000) });
    assert.equal(tooBig.status, 413);
    const notJson = await fetch(`${ctx.baseUrl}${base}`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: '{"name": ',
    });
    assert.equal(notJson.status, 400);
    await ctx.assertInvariants();
  });
});
