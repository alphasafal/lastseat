import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

let ctx;
let hackathon;

before(async () => {
  ctx = await startTestServer();
  hackathon = await ctx.hackathon({ min: 2, max: 3 });
});
after(() => ctx.stop());

const ask = (user, squad, message = 'I can help') =>
  user.post(`/api/teams/${squad.id}/requests`, { message });

describe('join requests', () => {
  test('a request is visible to the leader, and accepting it seats the person', async () => {
    const squad = await ctx.team(hackathon);
    const applicant = await ctx.participant(hackathon, { name: 'Applicant', skills: ['design'] });

    const created = await ask(applicant, squad, 'Designer here');
    assert.equal(created.status, 201);
    assert.equal(created.body.request.status, 'pending');

    const inbox = await squad.leader.get(`/api/teams/${squad.id}/requests`);
    assert.equal(inbox.body.requests.length, 1);
    assert.equal(inbox.body.requests[0].user.name, 'Applicant');
    assert.equal(inbox.body.requests[0].message, 'Designer here');

    const accepted = await squad.leader.post(`/api/requests/${created.body.request.id}/accept`);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.request.status, 'accepted');
    assert.equal(accepted.body.team.memberCount, 2);
    assert.ok(accepted.body.team.members.some((member) => member.userId === applicant.id));
    assert.equal(
      (await applicant.get(`/api/hackathons/${hackathon.id}/me`)).body.team.id,
      squad.id,
    );
  });

  test('only the leader can see, accept or decline requests', async () => {
    const squad = await ctx.team(hackathon);
    const member = await ctx.participant(hackathon);
    await member.post('/api/invites/join', { code: (await squad.invite()).code });
    const applicant = await ctx.participant(hackathon);
    const { body } = await ask(applicant, squad);

    for (const actor of [member, applicant, await ctx.participant(hackathon)]) {
      assert.equal((await actor.get(`/api/teams/${squad.id}/requests`)).status, 403);
      for (const verb of ['accept', 'decline']) {
        const res = await actor.post(`/api/requests/${body.request.id}/${verb}`);
        assert.equal(res.status, 403, `${actor.name} ${verb}`);
        assert.equal(res.body.error.code, 'NOT_TEAM_LEADER');
      }
    }
    assert.equal((await squad.fetch()).memberCount, 2);
  });

  test('declining leaves the team unchanged and the request cannot be decided twice', async () => {
    const squad = await ctx.team(hackathon);
    const applicant = await ctx.participant(hackathon);
    const { body } = await ask(applicant, squad);

    const declined = await squad.leader.post(`/api/requests/${body.request.id}/decline`);
    assert.equal(declined.status, 200);
    assert.equal(declined.body.request.status, 'declined');

    const again = await squad.leader.post(`/api/requests/${body.request.id}/accept`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'REQUEST_NOT_PENDING');
    assert.equal((await squad.fetch()).memberCount, 1);
    // After a decline the person may ask again.
    assert.equal((await ask(applicant, squad)).status, 201);
  });

  test('duplicate, self-serving and closed-door requests are refused', async () => {
    const squad = await ctx.team(hackathon);
    const applicant = await ctx.participant(hackathon);
    assert.equal((await ask(applicant, squad)).status, 201);

    const dup = await ask(applicant, squad);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'REQUEST_EXISTS');

    const fromMember = await ask(squad.leader, squad);
    assert.equal(fromMember.body.error.code, 'ALREADY_IN_TEAM');

    await squad.leader.patch(`/api/teams/${squad.id}`, { acceptingRequests: false });
    const closed = await ask(await ctx.participant(hackathon), squad);
    assert.equal(closed.body.error.code, 'REQUESTS_CLOSED');
  });

  test('a person can withdraw their own request, and nobody else can', async () => {
    const squad = await ctx.team(hackathon);
    const applicant = await ctx.participant(hackathon);
    const { body } = await ask(applicant, squad);

    const byOther = await squad.leader.post(`/api/requests/${body.request.id}/cancel`);
    assert.equal(byOther.status, 404, 'other people cannot even see that it exists');

    const cancelled = await applicant.post(`/api/requests/${body.request.id}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.request.status, 'cancelled');
    assert.equal(
      (await squad.leader.get(`/api/teams/${squad.id}/requests`)).body.requests.length,
      0,
    );
  });

  test('joining one team withdraws the requests to all the others', async () => {
    const [a, b, c] = [
      await ctx.team(hackathon),
      await ctx.team(hackathon),
      await ctx.team(hackathon),
    ];
    const applicant = await ctx.participant(hackathon);
    const toA = await ask(applicant, a);
    await ask(applicant, b);
    await ask(applicant, c);

    assert.equal((await a.leader.post(`/api/requests/${toA.body.request.id}/accept`)).status, 200);

    const mine = await applicant.get(`/api/hackathons/${hackathon.id}/requests/mine`);
    const byTeam = Object.fromEntries(mine.body.requests.map((r) => [r.teamId, r]));
    assert.equal(byTeam[a.id].status, 'accepted');
    assert.equal(byTeam[b.id].status, 'cancelled');
    assert.equal(byTeam[b.id].reason, 'joined_a_team');
    assert.equal(byTeam[c.id].status, 'cancelled');
    assert.equal((await b.leader.get(`/api/teams/${b.id}/requests`)).body.requests.length, 0);
    await ctx.assertInvariants();
  });

  test('accepting into a full team fails cleanly and the request stays pending', async () => {
    const squad = await ctx.team(hackathon);
    const applicant = await ctx.participant(hackathon);
    const { body } = await ask(applicant, squad);
    await ctx.fillTeam(hackathon, squad, 0);

    const res = await squad.leader.post(`/api/requests/${body.request.id}/accept`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TEAM_FULL');
    const mine = await applicant.get(`/api/hackathons/${hackathon.id}/requests/mine`);
    assert.equal(
      mine.body.requests[0].status,
      'pending',
      'nothing about the request was half-applied',
    );

    const tooLate = await ask(await ctx.participant(hackathon), squad);
    assert.equal(tooLate.body.error.code, 'TEAM_FULL');
  });

  test('at most 5 pending requests per person, even when sent in parallel', async () => {
    const squads = await Promise.all(Array.from({ length: 8 }, () => ctx.team(hackathon)));
    const applicant = await ctx.participant(hackathon);

    const results = await Promise.all(squads.map((squad) => ask(applicant, squad)));
    assert.equal(results.filter((res) => res.status === 201).length, 5);
    assert.equal(
      results.filter((res) => res.body?.error?.code === 'TOO_MANY_PENDING_REQUESTS').length,
      3,
    );
    await ctx.assertInvariants();
  });
});
