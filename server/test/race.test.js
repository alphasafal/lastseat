// The headline requirement: many people act at the same instant and the rules still hold.
// Every test here fires real concurrent HTTP requests at a real MongoDB replica set and then
// checks both the responses and the stored state.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { startTestServer } from './helpers.js';

let ctx;
let hackathon;

before(async () => {
  ctx = await startTestServer();
  hackathon = await ctx.hackathon({ min: 2, max: 4 });
});
after(() => ctx.stop());

const count = (results, predicate) => results.filter(predicate).length;

describe('race conditions', () => {
  test('50 people take the last seat at the same instant: exactly one gets it', async () => {
    const squad = await ctx.team(hackathon);
    const { invite } = await ctx.fillTeam(hackathon, squad, 1);
    const contenders = await Promise.all(
      Array.from({ length: 50 }, () => ctx.participant(hackathon)),
    );

    const results = await Promise.all(
      contenders.map((user) => user.post('/api/invites/join', { code: invite.code })),
    );

    const winners = results.filter((res) => res.status === 200);
    assert.equal(winners.length, 1, 'exactly one request may succeed');
    assert.equal(
      count(results, (res) => res.status === 409 && res.body.error.code === 'TEAM_FULL'),
      49,
      'everyone else is told the team is full',
    );

    const team = await squad.fetch();
    assert.equal(team.memberCount, 4);
    assert.equal(team.openSeats, 0);
    assert.equal(team.members.length, 4);
    assert.equal(new Set(team.members.map((member) => member.userId)).size, 4);

    // The winner in the response is the person who is actually stored in the team.
    const winner = contenders[results.findIndex((res) => res.status === 200)];
    assert.ok(team.members.some((member) => member.userId === winner.id));

    // Exactly one join was recorded for that seat, and nobody else was half-joined.
    const joins = await ctx.col
      .audit()
      .countDocuments({ teamId: new ctx.ObjectId(squad.id), type: 'member.joined' });
    assert.equal(joins, 3);
    const seated = await ctx.col
      .participants()
      .countDocuments({ teamId: new ctx.ObjectId(squad.id) });
    assert.equal(seated, 4);

    await ctx.assertInvariants();
  });

  test('3 open seats, 40 contenders: exactly three get in', async () => {
    const squad = await ctx.team(hackathon);
    const invite = await squad.invite();
    const contenders = await Promise.all(
      Array.from({ length: 40 }, () => ctx.participant(hackathon)),
    );

    const results = await Promise.all(
      contenders.map((user) => user.post('/api/invites/join', { code: invite.code })),
    );

    assert.equal(
      count(results, (res) => res.status === 200),
      3,
    );
    assert.equal(
      count(results, (res) => res.body?.error?.code === 'TEAM_FULL'),
      37,
    );
    assert.equal((await squad.fetch()).openSeats, 0);
    await ctx.assertInvariants();
  });

  test('a leader accepting 10 requests at once for one seat seats exactly one person', async () => {
    const squad = await ctx.team(hackathon);
    await ctx.fillTeam(hackathon, squad, 1);
    const applicants = await Promise.all(
      Array.from({ length: 10 }, () => ctx.participant(hackathon)),
    );
    const requests = await Promise.all(
      applicants.map((user) => user.post(`/api/teams/${squad.id}/requests`, { message: 'hi' })),
    );
    assert.ok(requests.every((res) => res.status === 201));

    const results = await Promise.all(
      requests.map((res) => squad.leader.post(`/api/requests/${res.body.request.id}/accept`)),
    );

    assert.equal(
      count(results, (res) => res.status === 200),
      1,
    );
    assert.equal(
      count(results, (res) => res.body?.error?.code === 'TEAM_FULL'),
      9,
    );
    await ctx.assertInvariants();
  });

  test('one person joining two teams at the same instant ends up in exactly one', async () => {
    const [a, b] = await Promise.all([ctx.team(hackathon), ctx.team(hackathon)]);
    const [inviteA, inviteB] = await Promise.all([a.invite(), b.invite()]);

    for (let round = 0; round < 10; round += 1) {
      const user = await ctx.participant(hackathon);
      const results = await Promise.all([
        user.post('/api/invites/join', { code: inviteA.code }),
        user.post('/api/invites/join', { code: inviteB.code }),
      ]);
      assert.equal(
        count(results, (res) => res.status === 200),
        1,
        `round ${round}`,
      );
      assert.equal(
        count(results, (res) => res.body?.error?.code === 'ALREADY_IN_TEAM'),
        1,
      );
      // Free the seat for the next round.
      const joined = results.find((res) => res.status === 200).body.team.id;
      assert.equal((await user.post(`/api/teams/${joined}/leave`)).status, 200);
    }
    await ctx.assertInvariants();
  });

  test('one person creating a team 20 times at once creates exactly one team', async () => {
    const user = await ctx.participant(hackathon);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        user.post(`/api/hackathons/${hackathon.id}/teams`, {
          name: `Burst ${randomUUID()}-${i}`.slice(0, 40),
        }),
      ),
    );
    assert.equal(
      count(results, (res) => res.status === 201),
      1,
    );
    assert.equal(
      count(results, (res) => res.body?.error?.code === 'ALREADY_IN_TEAM'),
      19,
    );
    const owned = await ctx.col.teams().countDocuments({ 'members.userId': user._id });
    assert.equal(owned, 1);
    await ctx.assertInvariants();
  });

  test('30 people claiming the same team name at once: one team is created', async () => {
    const users = await Promise.all(Array.from({ length: 30 }, () => ctx.participant(hackathon)));
    const results = await Promise.all(
      users.map((user) =>
        user.post(`/api/hackathons/${hackathon.id}/teams`, { name: 'The Only Ones' }),
      ),
    );
    assert.equal(
      count(results, (res) => res.status === 201),
      1,
    );
    assert.equal(
      count(results, (res) => res.body?.error?.code === 'TEAM_NAME_TAKEN'),
      29,
    );
    await ctx.assertInvariants();
  });

  test('the last member leaving while 20 people join: no ghost team, no lost seat', async () => {
    for (let round = 0; round < 5; round += 1) {
      const squad = await ctx.team(hackathon);
      const invite = await squad.invite();
      const joiners = await Promise.all(
        Array.from({ length: 20 }, () => ctx.participant(hackathon)),
      );

      const [leave, ...joins] = await Promise.all([
        squad.leader.post(`/api/teams/${squad.id}/leave`),
        ...joiners.map((user) => user.post('/api/invites/join', { code: invite.code })),
      ]);

      assert.equal(leave.status, 200);
      const joined = count(joins, (res) => res.status === 200);
      const team = await ctx.col.teams().findOne({ _id: new ctx.ObjectId(squad.id) });
      if (leave.body.teamDeleted) {
        // The leave won the race outright: the team is gone and nobody is stranded in it.
        assert.equal(team, null);
        assert.equal(joined, 0);
      } else {
        // Someone joined first: the team lives on and leadership passed to a real member.
        assert.equal(team.memberCount, joined);
        assert.ok(team.members.some((member) => String(member.userId) === String(team.leaderId)));
        assert.notEqual(String(team.leaderId), squad.leader.id);
      }
    }
    await ctx.assertInvariants();
  });

  test('mixed storm of joins, leaves, removals and transfers keeps every invariant', async () => {
    const squads = await Promise.all(Array.from({ length: 6 }, () => ctx.team(hackathon)));
    const invites = await Promise.all(squads.map((squad) => squad.invite()));
    const crowd = await Promise.all(Array.from({ length: 60 }, () => ctx.participant(hackathon)));

    for (let wave = 0; wave < 4; wave += 1) {
      const actions = crowd.map((user, i) => {
        const target = (i + wave) % squads.length;
        if ((i + wave) % 3 === 0) return user.post(`/api/teams/${squads[target].id}/leave`);
        return user.post('/api/invites/join', { code: invites[target].code });
      });
      // Leaders shuffle things at the same time.
      for (const squad of squads) {
        actions.push(
          squad.leader.get(`/api/teams/${squad.id}`).then(async ({ body }) => {
            const other = body.team?.members.find((member) => member.userId !== squad.leader.id);
            if (!other) return null;
            return wave % 2 === 0
              ? squad.leader.delete(`/api/teams/${squad.id}/members/${other.userId}`)
              : squad.leader.put(`/api/teams/${squad.id}/leader`, { userId: other.userId });
          }),
        );
      }
      const results = await Promise.all(actions);
      assert.equal(
        count(results, (res) => res && res.status >= 500),
        0,
        'contention must never surface as a server error',
      );
      await ctx.assertInvariants();
    }
  });
});
