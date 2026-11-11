import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { cachedPage, invalidateBoard, sendPage } from '../src/board/cache.js';

const H = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const decode = (page) => JSON.parse(page.json.toString());
// An event that changes both a team and a person: empties every kind of page.
const changed = (hackathonId) => ({ hackathonId, type: 'member.joined', team: {}, people: [{}] });

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe('board page cache', () => {
  test('100 simultaneous requests for one page run the query once', async () => {
    invalidateBoard(changed(H));
    let queries = 0;
    const produce = async () => {
      queries += 1;
      return { items: [1, 2, 3] };
    };
    const pages = await Promise.all(
      Array.from({ length: 100 }, () => cachedPage(H, 'teams|', produce)),
    );
    assert.equal(queries, 1);
    assert.ok(pages.every((page) => page === pages[0]));
    assert.deepEqual(decode(pages[0]), { items: [1, 2, 3] });
    assert.deepEqual(JSON.parse(gunzipSync(pages[0].gzip).toString()), { items: [1, 2, 3] });
  });

  test('an event empties the cache, so the next fetch sees the change', async () => {
    invalidateBoard(changed(H));
    let version = 1;
    const produce = async () => ({ version });
    assert.equal(decode(await cachedPage(H, 'teams|', produce)).version, 1);
    version = 2;
    assert.equal(decode(await cachedPage(H, 'teams|', produce)).version, 1, 'still cached');
    invalidateBoard(changed(H));
    assert.equal(decode(await cachedPage(H, 'teams|', produce)).version, 2);
  });

  test('a query that was in flight when the event arrived is never served afterwards', async () => {
    invalidateBoard(changed(H));
    const slow = deferred();
    const stale = cachedPage(H, 'teams|', () => slow.promise);

    invalidateBoard(changed(H)); // the change commits while the old query is still running
    const fresh = await cachedPage(H, 'teams|', async () => ({ state: 'after the change' }));
    slow.resolve({ state: 'before the change' });
    await stale;

    assert.equal(decode(fresh).state, 'after the change');
    const again = await cachedPage(H, 'teams|', async () => ({ state: 'should not run' }));
    assert.equal(
      decode(again).state,
      'after the change',
      'the late result did not overwrite the fresh one',
    );
  });

  test('pages and hackathons are cached separately, and a failed query is not remembered', async () => {
    invalidateBoard(changed(H));
    const other = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    await cachedPage(H, 'teams|', async () => ({ who: 'H teams' }));
    await cachedPage(H, 'people|', async () => ({ who: 'H people' }));
    await cachedPage(other, 'teams|', async () => ({ who: 'other teams' }));
    invalidateBoard(changed(H));
    assert.equal(
      decode(await cachedPage(other, 'teams|', async () => ({ who: 'miss' }))).who,
      'other teams',
    );
    assert.equal(
      decode(await cachedPage(H, 'people|', async () => ({ who: 'refetched' }))).who,
      'refetched',
    );

    await assert.rejects(cachedPage(H, 'teams|broken', () => Promise.reject(new Error('db down'))));
    assert.equal(decode(await cachedPage(H, 'teams|broken', async () => ({ ok: true }))).ok, true);
  });

  test('an event only empties the pages it can affect', async () => {
    invalidateBoard(changed(H));
    const fill = async () => {
      await cachedPage(H, 'teams|', async () => ({ v: 'old teams' }));
      await cachedPage(H, 'people|', async () => ({ v: 'old people' }));
    };
    const read = async (key) => decode(await cachedPage(H, key, async () => ({ v: 'fresh' }))).v;

    await fill();
    invalidateBoard({ hackathonId: H, type: 'team.updated', team: {} });
    assert.deepEqual([await read('teams|'), await read('people|')], ['fresh', 'old people']);

    invalidateBoard(changed(H));
    await fill();
    invalidateBoard({ hackathonId: H, type: 'participant.updated', people: [{}] });
    assert.deepEqual([await read('teams|'), await read('people|')], ['old teams', 'fresh']);

    invalidateBoard(changed(H));
    await fill();
    invalidateBoard({ hackathonId: H, type: 'team.deleted' });
    assert.equal(await read('teams|'), 'fresh');

    // Invites and join requests are not on the board at all.
    invalidateBoard(changed(H));
    await fill();
    invalidateBoard({ hackathonId: H, type: 'invite.created' });
    invalidateBoard({ hackathonId: H, type: 'request.created' });
    assert.deepEqual([await read('teams|'), await read('people|')], ['old teams', 'old people']);
  });

  test('responses are sent gzipped only to clients that accept gzip', async () => {
    const page = await cachedPage(H, 'teams|encoding', async () => ({ items: ['x'.repeat(500)] }));
    const send = (acceptEncoding) => {
      const headers = {};
      let body;
      sendPage(
        { get: () => acceptEncoding },
        { set: (name, value) => (headers[name] = value), end: (data) => (body = data) },
        page,
      );
      return { headers, body };
    };
    const zipped = send('gzip, deflate, br');
    assert.equal(zipped.headers['Content-Encoding'], 'gzip');
    assert.ok(zipped.body.length < page.json.length);
    const plain = send(undefined);
    assert.equal(plain.headers['Content-Encoding'], undefined);
    assert.equal(plain.body, page.json);
  });
});
