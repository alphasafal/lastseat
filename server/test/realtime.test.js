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

const ofType = (type, teamId) => (event) =>
  event.event === 'change' && event.data.type === type && (!teamId || event.data.teamId === teamId);

describe('live updates (server-sent events)', () => {
  test('the board hears about a new team and every seat taken, with full snapshots', async () => {
    const watcher = await ctx.participant(hackathon);
    const stream = await watcher.stream({ hackathonId: hackathon.id });
    assert.equal(stream.status, 200);
    await stream.waitFor((event) => event.event === 'ready');

    const squad = await ctx.team(hackathon, { name: 'Live Wires' });
    const created = await stream.waitFor(ofType('team.created', squad.id));
    assert.equal(created.data.team.name, 'Live Wires');
    assert.equal(created.data.team.openSeats, 3);
    assert.equal(
      created.data.people[0].lookingForTeam,
      false,
      'the creator leaves the people board',
    );

    const joiner = await ctx.participant(hackathon, { name: 'Joiner' });
    await joiner.post('/api/invites/join', { code: (await squad.invite()).code });
    const joined = await stream.waitFor(ofType('member.joined', squad.id));
    assert.equal(joined.data.team.memberCount, 2);
    assert.equal(joined.data.team.version, created.data.team.version + 1);
    assert.equal(joined.data.subject.name, 'Joiner');

    await joiner.post(`/api/teams/${squad.id}/leave`);
    await squad.leader.post(`/api/teams/${squad.id}/leave`);
    const deleted = await stream.waitFor(ofType('team.deleted', squad.id));
    assert.equal(deleted.data.team, undefined);
    stream.close();
  });

  test('join requests and invites are private to the team and the people involved', async () => {
    const squad = await ctx.team(hackathon);
    const applicant = await ctx.participant(hackathon);
    const outsider = await ctx.participant(hackathon);

    const leaderStream = await squad.leader.stream({ hackathonId: hackathon.id, teamId: squad.id });
    const applicantStream = await applicant.stream({ hackathonId: hackathon.id });
    // The outsider even asks for the team's stream; not being a member, they get public events only.
    const outsiderStream = await outsider.stream({ hackathonId: hackathon.id, teamId: squad.id });
    await Promise.all(
      [leaderStream, applicantStream, outsiderStream].map((s) =>
        s.waitFor((e) => e.event === 'ready'),
      ),
    );

    await squad.invite();
    const request = await applicant.post(`/api/teams/${squad.id}/requests`, {
      message: 'secret pitch',
    });
    await leaderStream.waitFor(ofType('invite.created', squad.id));
    await leaderStream.waitFor(ofType('request.created', squad.id));
    await applicantStream.waitFor(ofType('request.created', squad.id));

    await squad.leader.post(`/api/requests/${request.body.request.id}/decline`);
    const declined = await applicantStream.waitFor(ofType('request.declined', squad.id));
    assert.equal(declined.data.subject.userId, applicant.id);

    // A public event after all of the above proves the outsider's stream is alive and in order.
    await squad.leader.patch(`/api/teams/${squad.id}`, { description: 'now public' });
    await outsiderStream.waitFor(ofType('team.updated', squad.id));
    const leaked = outsiderStream.events.filter((e) =>
      /^(invite|request)\./.test(e.data?.type ?? ''),
    );
    assert.deepEqual(leaked, []);
    assert.ok(!JSON.stringify(outsiderStream.events).includes('secret pitch'));
    for (const stream of [leaderStream, applicantStream, outsiderStream]) stream.close();
  });

  test("a removed member stops receiving the team's private events immediately", async () => {
    const squad = await ctx.team(hackathon);
    const member = await ctx.participant(hackathon);
    await member.post('/api/invites/join', { code: (await squad.invite()).code });

    const stream = await member.stream({ hackathonId: hackathon.id, teamId: squad.id });
    await stream.waitFor((event) => event.event === 'ready');

    await squad.invite();
    await stream.waitFor(ofType('invite.created', squad.id));

    await squad.leader.delete(`/api/teams/${squad.id}/members/${member.id}`);
    const removed = await stream.waitFor(ofType('member.removed', squad.id));
    assert.equal(removed.data.subject.userId, member.id, 'they are told they were removed');

    const before = stream.events.length;
    await squad.invite();
    await squad.leader.patch(`/api/teams/${squad.id}`, { description: 'after removal' });
    await stream.waitFor(ofType('team.updated', squad.id));
    const after = stream.events.slice(before).map((event) => event.data.type);
    assert.ok(!after.includes('invite.created'), `leaked: ${after}`);
    stream.close();
  });

  test('a stream needs a valid hackathon id and a user may only hold a few at once', async () => {
    const user = await ctx.participant(hackathon);
    assert.equal((await user.get('/api/stream')).status, 400);
    assert.equal((await user.get('/api/stream?hackathonId=nope')).status, 400);

    const open = [];
    for (let i = 0; i < 6; i += 1) open.push(await user.stream({ hackathonId: hackathon.id }));
    assert.ok(open.every((stream) => stream.status === 200));
    const seventh = await user.get(`/api/stream?hackathonId=${hackathon.id}`);
    assert.equal(seventh.status, 429);
    for (const stream of open) stream.close();
  });
});
