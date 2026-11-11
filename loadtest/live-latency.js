// Measures how quickly a committed change reaches people watching the board.
//
//   node loadtest/live-latency.js                 # 300 streams, 20 s of writes
//   STREAMS=1000 SECONDS=30 node loadtest/live-latency.js
//
// Opens STREAMS server-sent-event connections as seeded users, then has a few writers
// create, edit and dissolve teams. For every event received it records
// (time received - time the server stamped the change), which covers the transaction, the
// change stream hop and the fan-out to every connection.

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4000';
const STREAMS = Number(process.env.STREAMS ?? 300);
const SECONDS = Number(process.env.SECONDS ?? 20);
const WRITERS = Number(process.env.WRITERS ?? 4);
const PASSWORD = process.env.SEED_PASSWORD ?? 'hackathon-demo';
const STREAMS_PER_USER = 5;

const email = (n) => `user${String(n).padStart(5, '0')}@seed.lastseat.test`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login(n) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email(n), password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email(n)}: ${res.status}`);
  return res.headers.get('set-cookie').split(';')[0];
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const latencies = [];
let received = 0;
let ready = 0;

async function openStream(cookie, hackathonId, signal) {
  const res = await fetch(`${BASE_URL}/api/stream?hackathonId=${hackathonId}`, {
    headers: { cookie },
    signal,
  });
  if (res.status !== 200) throw new Error(`stream refused: ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for await (const chunk of res.body) {
        const now = Date.now();
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.includes('event: ready')) ready += 1;
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!frame.includes('event: change') || !data) continue;
          received += 1;
          latencies.push(now - new Date(JSON.parse(data.slice(6)).at).getTime());
        }
      }
    } catch {
      // closed at the end of the run
    }
  })();
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

const users = Math.ceil(STREAMS / STREAMS_PER_USER);
console.log(`Signing in ${users} viewers and ${WRITERS} writers...`);
const viewerCookies = [];
for (let i = 0; i < users; i += 1) viewerCookies.push(await login(200 + i));
const writerCookies = [];
for (let i = 0; i < WRITERS; i += 1) writerCookies.push(await login(9900 - i));

const { body: list } = await api(viewerCookies[0], 'GET', '/api/hackathons');
const hackathon = list.hackathons.find((h) => h.slug === 'winter-build-2026');
if (!hackathon) throw new Error('run `npm run seed` first');

const controller = new AbortController();
console.log(`Opening ${STREAMS} streams...`);
await Promise.all(
  Array.from({ length: STREAMS }, (_, i) =>
    openStream(viewerCookies[Math.floor(i / STREAMS_PER_USER)], hackathon.id, controller.signal),
  ),
);
while (ready < STREAMS) await sleep(50);

console.log(`Writing for ${SECONDS} s...`);
const deadline = Date.now() + SECONDS * 1000;
let writes = 0;
await Promise.all(
  writerCookies.map(async (cookie, w) => {
    for (let i = 0; Date.now() < deadline; i += 1) {
      const created = await api(cookie, 'POST', `/api/hackathons/${hackathon.id}/teams`, {
        name: `Live ${w}-${i}-${Date.now() % 100000}`,
      });
      if (created.status !== 201) {
        const me = await api(cookie, 'GET', `/api/hackathons/${hackathon.id}/me`);
        if (me.body?.team) await api(cookie, 'POST', `/api/teams/${me.body.team.id}/leave`);
        continue;
      }
      const id = created.body.team.id;
      await api(cookie, 'PATCH', `/api/teams/${id}`, { description: 'live' });
      await api(cookie, 'POST', `/api/teams/${id}/leave`);
      writes += 3;
      await sleep(100);
    }
  }),
);
await sleep(1500); // let the last events arrive
controller.abort();

// create -> 1 event, update -> 1, leave (last member) -> member.left + team.deleted = 2
const publicEvents = (writes / 3) * 4;
const expected = publicEvents * STREAMS;
const sorted = latencies.sort((a, b) => a - b);
const result = {
  streams: STREAMS,
  seconds: SECONDS,
  writes,
  publicEvents,
  eventsExpected: expected,
  eventsReceived: received,
  delivered: `${((received / expected) * 100).toFixed(2)} %`,
  latencyMs: {
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1),
  },
};
console.log(JSON.stringify(result, null, 2));
process.exit(received === expected ? 0 : 1);
