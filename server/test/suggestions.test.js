import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { overlapMinutes, rankCandidates, scoreCandidate } from '../src/board/score.js';
import { startTestServer } from './helpers.js';

const options = {
  weights: { wanted: 0.45, complementary: 0.3, timezone: 0.25 },
  activeWindow: { startHour: 9, endHour: 22 },
};
const IST = 330;

describe('suggestion scoring (pure functions)', () => {
  test('time-zone overlap is the shared part of two 13-hour local days', () => {
    const window = options.activeWindow;
    assert.equal(overlapMinutes(IST, IST, window), 13 * 60, 'same zone: the whole window');
    assert.equal(overlapMinutes(IST, 60, window), 13 * 60 - 270, 'India vs Berlin: 4.5 h apart');
    assert.equal(overlapMinutes(60, IST, window), overlapMinutes(IST, 60, window), 'symmetric');
    // 12 hours apart, two 13-hour windows still touch for an hour at each end.
    assert.equal(overlapMinutes(0, 720, window), 120);
    // Offsets on either side of the date line are close, not 24 hours apart.
    assert.equal(overlapMinutes(-660, 780, window), overlapMinutes(0, 0, window));
  });

  test('a person who brings the wanted skill outranks one who duplicates the team', () => {
    const context = { have: ['backend', 'devops'], wanted: ['design'], offsets: [IST] };
    const designer = scoreCandidate(
      context,
      { skills: ['design', 'frontend'], utcOffsetMinutes: IST },
      options,
    );
    const clone = scoreCandidate(
      context,
      { skills: ['backend', 'devops'], utcOffsetMinutes: IST },
      options,
    );

    // wanted 1/1, complementary 2/3, timezone 1  ->  100 * (0.45 + 0.30 * 2/3 + 0.25) = 90
    assert.equal(designer.score, 90);
    // wanted 0, complementary 0, timezone 1      ->  25
    assert.equal(clone.score, 25);
    assert.deepEqual(designer.breakdown.wanted.skills, ['design']);
    assert.deepEqual(designer.breakdown.complementary.skills, ['design', 'frontend']);
    assert.deepEqual(clone.breakdown.sharedSkills, ['backend', 'devops']);
    assert.ok(designer.reasons.some((reason) => reason.includes('design')));
    assert.ok(clone.reasons.some((reason) => /same skills/i.test(reason)));
  });

  test('with no wanted skills the weight is shared out instead of capping every score', () => {
    const context = { have: ['backend'], wanted: [], offsets: [IST] };
    const result = scoreCandidate(
      context,
      { skills: ['design', 'ml', 'data'], utcOffsetMinutes: IST },
      options,
    );
    assert.equal(result.score, 100);
    assert.equal(result.breakdown.wanted.weight, 0);
    assert.equal(
      Math.round((result.breakdown.complementary.weight + result.breakdown.timezone.weight) * 100),
      100,
    );
  });

  test('between equal skill sets, the closer time zone wins', () => {
    const context = { have: ['backend'], wanted: ['design'], offsets: [IST, IST] };
    const ranked = rankCandidates(
      context,
      [
        { name: 'Far', skills: ['design'], utcOffsetMinutes: -480 },
        { name: 'Near', skills: ['design'], utcOffsetMinutes: 345 },
      ],
      options,
    );
    assert.deepEqual(
      ranked.map((row) => row.candidate.name),
      ['Near', 'Far'],
    );
    assert.ok(
      ranked[0].breakdown.timezone.overlapHours > ranked[1].breakdown.timezone.overlapHours,
    );
  });
});

describe('GET /suggestions', () => {
  let ctx;
  let hackathon;

  before(async () => {
    ctx = await startTestServer();
    hackathon = await ctx.hackathon({ min: 2, max: 4 });
  });
  after(() => ctx.stop());

  test('ranks people for my team and explains every score', async () => {
    const leader = await ctx.participant(hackathon, {
      name: 'Lead',
      skills: ['backend', 'devops'],
    });
    const squad = await ctx.team(hackathon, { leader, lookingFor: ['design', 'ml'] });
    await ctx.participant(hackathon, { name: 'Designer Nearby', skills: ['design', 'frontend'] });
    await ctx.participant(hackathon, {
      name: 'Designer Far',
      skills: ['design', 'frontend'],
      timezone: 'America/Los_Angeles',
    });
    await ctx.participant(hackathon, { name: 'Backend Twin', skills: ['backend'] });
    const taken = await ctx.participant(hackathon, {
      name: 'Already Taken',
      skills: ['design', 'ml'],
    });
    await ctx.team(hackathon, { leader: taken });

    const res = await leader.get(`/api/hackathons/${hackathon.id}/suggestions`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.basedOn, { kind: 'team', teamId: squad.id, name: squad.team.name });
    assert.deepEqual(res.body.context.wanted, ['design', 'ml']);

    const names = res.body.suggestions.map((row) => row.person.name);
    assert.deepEqual(names.slice(0, 2), ['Designer Nearby', 'Designer Far']);
    assert.ok(names.indexOf('Backend Twin') > 1);
    assert.ok(!names.includes('Already Taken'), 'people who have a team are not suggested');
    assert.ok(!names.includes('Lead'), 'you are not suggested to yourself');

    for (const row of res.body.suggestions) {
      const { wanted, complementary, timezone } = row.breakdown;
      const recomputed =
        100 *
        (wanted.weight * wanted.score +
          complementary.weight * complementary.score +
          timezone.weight * timezone.score);
      assert.ok(Math.abs(recomputed - row.score) < 1, 'the breakdown must add up to the score');
      assert.ok(row.reasons.length > 0);
    }
    assert.equal(res.body.scoring.weights.wanted, 0.45);
    assert.ok(res.body.scoring.explanation.length >= 3);
    assert.ok(res.body.considered >= 3);
  });

  test('works for someone without a team and requires registration', async () => {
    const solo = await ctx.participant(hackathon, { name: 'Solo', skills: ['design'] });
    const res = await solo.get(`/api/hackathons/${hackathon.id}/suggestions?limit=2`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.basedOn, { kind: 'you' });
    assert.equal(res.body.suggestions.length, 2);

    const stranger = await ctx.user();
    const denied = await stranger.get(`/api/hackathons/${hackathon.id}/suggestions`);
    assert.equal(denied.body.error.code, 'NOT_REGISTERED');
  });
});
