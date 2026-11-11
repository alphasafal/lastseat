import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

let ctx;
let hackathon;

before(async () => {
  ctx = await startTestServer();
  hackathon = await ctx.hackathon({ min: 2, max: 2 });
});
after(() => ctx.stop());

async function walk(user, path, limit) {
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    const sep = path.includes('?') ? '&' : '?';
    const res = await user.get(`${path}${sep}${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    seen.push(...res.body.items);
    cursor = res.body.nextCursor;
    pages += 1;
  } while (cursor);
  return { seen, pages };
}

describe('teammate board', () => {
  test('lists only teams with an open seat, newest activity first, without gaps or repeats', async () => {
    const viewer = await ctx.participant(hackathon);
    const squads = [];
    for (let i = 0; i < 7; i += 1)
      squads.push(await ctx.team(hackathon, { name: `Board Team ${i}` }));
    // Fill two of them: with a maximum of 2, one join makes a team full.
    for (const squad of squads.slice(0, 2)) await ctx.fillTeam(hackathon, squad, 0);

    const base = `/api/hackathons/${hackathon.id}/board/teams`;
    const { seen, pages } = await walk(viewer, base, 2);
    const names = seen.map((team) => team.name);

    assert.equal(pages, 3);
    assert.equal(names.length, 5);
    assert.equal(new Set(names).size, 5, 'no team may appear on two pages');
    assert.ok(
      !names.includes('Board Team 0') && !names.includes('Board Team 1'),
      'full teams are hidden',
    );
    assert.ok(seen.every((team) => team.openSeats > 0));
    const times = seen.map((team) => new Date(team.updatedAt).getTime());
    assert.deepEqual(
      times,
      [...times].sort((a, b) => b - a),
    );
  });

  test('a team leaves the board the moment it fills and returns when a seat frees up', async () => {
    const viewer = await ctx.participant(hackathon);
    const squad = await ctx.team(hackathon, { name: 'Blink' });
    const onBoard = async () =>
      (await walk(viewer, `/api/hackathons/${hackathon.id}/board/teams`, 50)).seen.some(
        (t) => t.id === squad.id,
      );

    assert.equal(await onBoard(), true);
    const { team } = await ctx.fillTeam(hackathon, squad, 0);
    assert.equal(await onBoard(), false);
    await squad.leader.delete(`/api/teams/${squad.id}/members/${team.members[1].userId}`);
    assert.equal(await onBoard(), true);
  });

  test("filters by the skill a team is looking for and by a person's skills", async () => {
    const viewer = await ctx.participant(hackathon);
    await ctx.team(hackathon, { name: 'Needs ML', lookingFor: ['ml', 'data'] });
    await ctx.team(hackathon, { name: 'Needs Design', lookingFor: ['design'] });
    await ctx.participant(hackathon, { name: 'Hardware Hana', skills: ['hardware'] });

    const teams = await viewer.get(`/api/hackathons/${hackathon.id}/board/teams?skill=ml`);
    assert.deepEqual(
      teams.body.items.map((team) => team.name),
      ['Needs ML'],
    );

    const people = await viewer.get(`/api/hackathons/${hackathon.id}/board/people?skill=hardware`);
    assert.deepEqual(
      people.body.items.map((person) => person.name),
      ['Hardware Hana'],
    );

    const bad = await viewer.get(`/api/hackathons/${hackathon.id}/board/teams?skill=juggling`);
    assert.equal(bad.status, 400);
    const badCursor = await viewer.get(`/api/hackathons/${hackathon.id}/board/teams?cursor=%7B%7D`);
    assert.equal(badCursor.status, 400);
    const tooMany = await viewer.get(`/api/hackathons/${hackathon.id}/board/teams?limit=500`);
    assert.equal(tooMany.status, 400);
  });

  test('the people board shows who is looking and drops them when they join or opt out', async () => {
    const viewer = await ctx.participant(hackathon, { name: 'Viewer' });
    const solo = await ctx.participant(hackathon, { name: 'Solo Sam' });
    const shy = await ctx.participant(hackathon, { name: 'Shy Shreya' });
    const listed = async () =>
      (await walk(viewer, `/api/hackathons/${hackathon.id}/board/people`, 50)).seen.map(
        (p) => p.name,
      );

    assert.ok((await listed()).includes('Solo Sam'));

    const optOut = await shy.patch(`/api/hackathons/${hackathon.id}/me`, {
      lookingForTeam: false,
      headline: 'Just browsing',
    });
    assert.equal(optOut.status, 200);
    assert.ok(!(await listed()).includes('Shy Shreya'));

    await ctx.team(hackathon, { leader: solo });
    assert.ok(!(await listed()).includes('Solo Sam'));

    const cannot = await solo.patch(`/api/hackathons/${hackathon.id}/me`, { lookingForTeam: true });
    assert.equal(cannot.body.error.code, 'ALREADY_IN_TEAM');
  });

  test('profile changes are copied into the team so the board never shows stale skills', async () => {
    const squad = await ctx.team(hackathon);
    const res = await squad.leader.patch(`/api/hackathons/${hackathon.id}/me`, {
      skills: ['security', 'devops'],
      timezone: 'Europe/London',
    });
    assert.equal(res.status, 200);
    const team = await squad.fetch();
    assert.deepEqual(team.members[0].skills, ['security', 'devops']);
    assert.equal(team.members[0].utcOffsetMinutes, res.body.me.utcOffsetMinutes);
    await ctx.assertInvariants();
  });

  test('the hackathon endpoint reports size rules and board totals', async () => {
    const viewer = await ctx.participant(hackathon);
    const res = await viewer.get(`/api/hackathons/${hackathon.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.hackathon.minTeamSize, 2);
    assert.equal(res.body.hackathon.maxTeamSize, 2);
    assert.equal(typeof res.body.totals.openTeams, 'number');
    assert.equal(typeof res.body.totals.peopleLooking, 'number');
    assert.equal((await viewer.get('/api/hackathons')).body.hackathons.length, 1);
  });
});
