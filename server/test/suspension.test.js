import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

// A serverless host freezes an idle process. These tests cannot freeze the test process, so
// they tell the check that a minute has passed, which is all a thawed process knows as well.

let ctx;
let hackathon;
let config;
let checkForPause;
let mongoClient;

before(async () => {
  ctx = await startTestServer();
  hackathon = await ctx.hackathon({ min: 2, max: 4 });
  ({ config } = await import('../src/config.js'));
  ({ checkForPause } = await import('../src/suspension.js'));
  ({ mongoClient } = await import('../src/db.js'));
});
after(() => ctx.stop());

const created = (teamId) => (event) =>
  event.event === 'change' && event.data.type === 'team.created' && event.data.teamId === teamId;

describe('recovering from a suspended process', () => {
  test('it is off unless configured, and a short gap is not a pause', async () => {
    const client = mongoClient();
    config.reconnectAfterPauseMs = 0;
    assert.equal(await checkForPause(Date.now() + 60_000), null);

    config.reconnectAfterPauseMs = 15_000;
    await checkForPause(); // bring the clock back from the previous call
    assert.equal(await checkForPause(Date.now() + 2_000), null);
    assert.equal(mongoClient(), client, 'the database client was not replaced');
  });

  test('after a pause the client is replaced, requests work and live events still arrive once', async () => {
    const watcher = await ctx.participant(hackathon);
    const stream = await watcher.stream({ hackathonId: hackathon.id });
    await stream.waitFor((event) => event.event === 'ready');
    const before = await ctx.team(hackathon, { name: 'Before The Pause' });
    await stream.waitFor(created(before.id));

    const client = mongoClient();
    config.reconnectAfterPauseMs = 15_000;
    await checkForPause(); // bring the clock back from the previous test
    await checkForPause(Date.now() + 60_000);
    assert.notEqual(mongoClient(), client, 'the database client was replaced');

    const afterwards = await ctx.team(hackathon, { name: 'After The Pause' });
    const event = await stream.waitFor(created(afterwards.id));
    assert.equal(event.data.team.name, 'After The Pause');

    // The abandoned change stream must not deliver the same event a second time.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stream.events.filter(created(afterwards.id)).length, 1);
    assert.equal(stream.events.filter(created(before.id)).length, 1);

    stream.close();
    await ctx.assertInvariants();
  });

  test('two requests arriving together after a pause share one reconnect', async () => {
    const client = mongoClient();
    await checkForPause();
    const first = checkForPause(Date.now() + 60_000);
    const second = checkForPause(Date.now() + 120_000);
    assert.equal(first, second);
    await first;
    const replaced = mongoClient();
    assert.notEqual(replaced, client);
    const user = await ctx.participant(hackathon);
    assert.equal((await user.get(`/api/hackathons/${hackathon.id}/me`)).status, 200);
    assert.equal(mongoClient(), replaced, 'an ordinary request does not reconnect again');
  });
});
