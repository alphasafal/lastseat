import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { cachedPage, invalidateBoard, sendPage } from '../src/board/cache.js';

const H = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const decode = (page) => JSON.parse(page.json.toString());

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe('board page cache', () => {
  test('100 simultaneous requests for one page run the query once', async () => {
    invalidateBoard(H);
    let queries = 0;
    const produce = async () => {
      queries += 1;
      return { items: [1, 2, 3] };
    };
    const pages = await Promise.all(
      Array.from({ length: 100 }, () => cachedPage(H, 'teams', produce)),
    );
    assert.equal(queries, 1);
    assert.ok(pages.every((page) => page === pages[0]));
    assert.deepEqual(decode(pages[0]), { items: [1, 2, 3] });
    assert.deepEqual(JSON.parse(gunzipSync(pages[0].gzip).toString()), { items: [1, 2, 3] });
  });

  test('an event empties the cache, so the next fetch sees the change', async () => {
    invalidateBoard(H);
    let version = 1;
    const produce = async () => ({ version });
    assert.equal(decode(await cachedPage(H, 'teams', produce)).version, 1);
    version = 2;
    assert.equal(decode(await cachedPage(H, 'teams', produce)).version, 1, 'still cached');
    invalidateBoard(H);
    assert.equal(decode(await cachedPage(H, 'teams', produce)).version, 2);
  });

  test('a query that was in flight when the event arrived is never served afterwards', async () => {
    invalidateBoard(H);
    const slow = deferred();
    const stale = cachedPage(H, 'teams', () => slow.promise);

    invalidateBoard(H); // the change commits while the old query is still running
    const fresh = await cachedPage(H, 'teams', async () => ({ state: 'after the change' }));
    slow.resolve({ state: 'before the change' });
    await stale;

    assert.equal(decode(fresh).state, 'after the change');
    const again = await cachedPage(H, 'teams', async () => ({ state: 'should not run' }));
    assert.equal(
      decode(again).state,
      'after the change',
      'the late result did not overwrite the fresh one',
    );
  });

  test('pages and hackathons are cached separately, and a failed query is not remembered', async () => {
    invalidateBoard(H);
    const other = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    await cachedPage(H, 'teams', async () => ({ who: 'H teams' }));
    await cachedPage(H, 'people', async () => ({ who: 'H people' }));
    await cachedPage(other, 'teams', async () => ({ who: 'other teams' }));
    invalidateBoard(H);
    assert.equal(
      decode(await cachedPage(other, 'teams', async () => ({ who: 'miss' }))).who,
      'other teams',
    );
    assert.equal(
      decode(await cachedPage(H, 'people', async () => ({ who: 'refetched' }))).who,
      'refetched',
    );

    await assert.rejects(cachedPage(H, 'broken', () => Promise.reject(new Error('db down'))));
    assert.equal(decode(await cachedPage(H, 'broken', async () => ({ ok: true }))).ok, true);
  });

  test('responses are sent gzipped only to clients that accept gzip', async () => {
    const page = await cachedPage(H, 'encoding', async () => ({ items: ['x'.repeat(500)] }));
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
