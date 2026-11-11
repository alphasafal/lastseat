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

describe('audit log', () => {
  test('records who did what and when for every kind of team change', async () => {
    const leader = await ctx.participant(hackathon, { name: 'Lena Leader' });
    const squad = await ctx.team(hackathon, { leader, name: 'Paper Trail' });
    const started = Date.now();

    const invite = await squad.invite();
    const viaCode = await ctx.participant(hackathon, { name: 'Cody Code' });
    await viaCode.post('/api/invites/join', { code: invite.code });
    const viaRequest = await ctx.participant(hackathon, { name: 'Rhea Request' });
    const request = await viaRequest.post(`/api/teams/${squad.id}/requests`, { message: 'hello' });
    await leader.post(`/api/requests/${request.body.request.id}/accept`);
    const declined = await ctx.participant(hackathon, { name: 'Dev Declined' });
    const second = await declined.post(`/api/teams/${squad.id}/requests`);
    await leader.post(`/api/requests/${second.body.request.id}/decline`);
    await leader.patch(`/api/teams/${squad.id}`, { description: 'documented' });
    await leader.delete(`/api/teams/${squad.id}/invites/${invite.id}`);
    await leader.delete(`/api/teams/${squad.id}/members/${viaCode.id}`);
    await leader.put(`/api/teams/${squad.id}/leader`, { userId: viaRequest.id });
    await viaRequest.post(`/api/teams/${squad.id}/leave`);

    const res = await leader.get(`/api/teams/${squad.id}/audit`);
    assert.equal(res.status, 200);
    const log = res.body.entries.reverse(); // oldest first
    const summary = log.map((e) => `${e.type}|${e.actor.name}|${e.subject?.name ?? '-'}`);
    assert.deepEqual(summary, [
      'team.created|Lena Leader|-',
      'invite.created|Lena Leader|-',
      'member.joined|Cody Code|Cody Code',
      'request.created|Rhea Request|-',
      'member.joined|Lena Leader|Rhea Request',
      'request.accepted|Lena Leader|Rhea Request',
      'request.created|Dev Declined|-',
      'request.declined|Lena Leader|Dev Declined',
      'team.updated|Lena Leader|-',
      'invite.revoked|Lena Leader|-',
      'member.removed|Lena Leader|Cody Code',
      'leader.changed|Lena Leader|Rhea Request',
      'member.left|Rhea Request|Rhea Request',
      'leader.changed|Rhea Request|Lena Leader',
    ]);

    assert.equal(log[2].data.via, 'invite');
    assert.equal(log[4].data.via, 'request');
    assert.equal(log[11].data.reason, 'transferred');
    assert.equal(log[13].data.reason, 'previous_leader_left');
    for (const entry of log) {
      const at = new Date(entry.at).getTime();
      assert.ok(
        at >= started - 1000 && at <= Date.now() + 1000,
        'timestamps come from the server clock',
      );
      assert.equal(entry.team, undefined, 'snapshots are for the live stream, not the log API');
    }
    assert.ok(!JSON.stringify(log).includes(invite.code), 'invite codes never reach the log');
  });

  test('is readable by current members only, and paginates', async () => {
    const squad = await ctx.team(hackathon);
    const member = await ctx.participant(hackathon);
    await member.post('/api/invites/join', { code: (await squad.invite()).code });
    const outsider = await ctx.participant(hackathon);

    assert.equal((await member.get(`/api/teams/${squad.id}/audit`)).status, 200);
    const denied = await outsider.get(`/api/teams/${squad.id}/audit`);
    assert.equal(denied.status, 403);

    const first = await member.get(`/api/teams/${squad.id}/audit?limit=2`);
    assert.equal(first.body.entries.length, 2);
    const next = await member.get(
      `/api/teams/${squad.id}/audit?limit=2&before=${first.body.entries[1].id}`,
    );
    assert.equal(next.body.entries.length, 1);
    assert.equal(next.body.entries[0].type, 'team.created');

    await squad.leader.delete(`/api/teams/${squad.id}/members/${member.id}`);
    assert.equal(
      (await member.get(`/api/teams/${squad.id}/audit`)).status,
      403,
      'access ends with membership',
    );
  });

  test('a deleted team keeps its history, which organizers can still read', async () => {
    const squad = await ctx.team(hackathon, { name: 'Short Lived' });
    await squad.leader.post(`/api/teams/${squad.id}/leave`);

    const organizer = await ctx.user({ role: 'organizer' });
    const res = await organizer.get(`/api/hackathons/${hackathon.id}/audit?limit=100`);
    assert.equal(res.status, 200);
    const types = res.body.entries
      .filter((entry) => entry.teamId === squad.id)
      .map((entry) => entry.type);
    assert.deepEqual(types, ['team.deleted', 'member.left', 'team.created']);

    const participant = await ctx.participant(hackathon);
    assert.equal((await participant.get(`/api/hackathons/${hackathon.id}/audit`)).status, 403);
  });

  test('a rejected action leaves no trace in the log', async () => {
    const squad = await ctx.team(hackathon);
    const { invite } = await ctx.fillTeam(hackathon, squad, 0);
    const before = await ctx.col.audit().countDocuments();
    const late = await ctx.participant(hackathon); // registering writes one participant entry
    const res = await late.post('/api/invites/join', { code: invite.code });
    assert.equal(res.body.error.code, 'TEAM_FULL');
    assert.equal(await ctx.col.audit().countDocuments(), before + 1);
    await ctx.assertInvariants();
  });
});
