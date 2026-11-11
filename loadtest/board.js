// k6 load test for the teammate board.
//
//   k6 run loadtest/board.js                                  # 100 users, 2 minutes
//   k6 run -e BASE_URL=https://your-app.onrender.com loadtest/board.js
//   k6 run -e MODE=saturate loadtest/board.js                 # no think time: find the ceiling
//
// Prerequisite: `npm run seed` (10,000 users, 2,000 teams). Each virtual user signs in as a
// different seeded account, so sessions, cookies and per-user rate limits behave as in real use.
// Start the server with RATE_AUTH_PER_IP=100000: all virtual users share one IP address.

import exec from 'k6/execution';
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:4000';
const MODE = __ENV.MODE || 'steady';
const READERS = Number(__ENV.READERS || 100);
const WRITERS = Number(__ENV.WRITERS || 10);
const DURATION = __ENV.DURATION || '2m';
const PASSWORD = __ENV.SEED_PASSWORD || 'hackathon-demo';
const SKILLS = ['frontend', 'backend', 'design', 'ml', 'data', 'devops', 'mobile', 'product'];

const boardLatency = new Trend('board_latency', true);
const writeLatency = new Trend('write_latency', true);
const boardRequests = new Counter('board_requests');
const writesDone = new Counter('writes_done');

const RAMP = __ENV.RAMP || '10s';

// Users arrive over a short ramp, as they would when a board opens, then stay for DURATION.
const stages = (target) => [
  { duration: RAMP, target },
  { duration: DURATION, target },
];

export const options = {
  scenarios: {
    // 100 people browsing the board at once.
    readers: {
      executor: 'ramping-vus',
      exec: 'browseBoard',
      startVUs: 0,
      stages: stages(READERS),
      gracefulRampDown: '5s',
    },
    // Meanwhile teams are being created, edited and dissolved, so the board is read under
    // real write traffic (transactions, audit entries, change-stream fan-out).
    ...(WRITERS > 0
      ? {
          writers: {
            executor: 'ramping-vus',
            exec: 'churnTeams',
            startVUs: 0,
            stages: stages(WRITERS),
            gracefulRampDown: '5s',
          },
        }
      : {}),
  },
  thresholds: {
    // The requirement: p95 under 200 ms on the board endpoint with 100 concurrent users.
    board_latency: ['p(95)<200'],
    'http_req_failed{scenario:readers}': ['rate<0.001'],
    checks: ['rate>0.999'],
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function email(n) {
  return `user${String(n).padStart(5, '0')}@seed.lastseat.test`;
}

function login(n) {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: email(n), password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } },
  );
  if (res.status !== 200)
    throw new Error(`login failed for ${email(n)}: ${res.status} ${res.body}`);
  return `sid=${res.cookies.sid[0].value}`;
}

export function setup() {
  const list = http.get(`${BASE_URL}/api/hackathons`, { headers: { Cookie: login(1) } });
  const hackathon = list.json('hackathons').find((h) => h.slug === 'winter-build-2026');
  if (!hackathon) throw new Error('seeded hackathon not found: run `npm run seed` first');
  return { hackathonId: hackathon.id };
}

// Each virtual user signs in once, as its own seeded account. The account number comes from
// the VU's test-wide id, so two VUs can never share an account (which would make them undo
// each other's work). Readers count up from user 1; writers count down from user 10,000,
// where the seed leaves people without a team.
let session = null;
function signedIn(role) {
  if (!session) {
    const id = exec.vu.idInTest;
    session = login(role === 'writer' ? 10001 - id : id);
  }
  return session;
}

function think(min, max) {
  if (MODE === 'saturate') return;
  sleep(min + Math.random() * (max - min));
}

function getBoard(path, cookie, name) {
  const res = http.get(`${BASE_URL}${path}`, { headers: { Cookie: cookie }, tags: { name } });
  boardLatency.add(res.timings.duration);
  boardRequests.add(1);
  check(res, {
    'board 200': (r) => r.status === 200,
    'board has rows': (r) => Array.isArray(r.json('items')) && r.json('items').length > 0,
  });
  return res;
}

// What a person does on the board: open it, scroll a page or two, switch to people, filter.
export function browseBoard(data) {
  const cookie = signedIn('reader');
  const base = `/api/hackathons/${data.hackathonId}/board`;

  group('teams', () => {
    const first = getBoard(`${base}/teams`, cookie, 'board/teams');
    think(0.5, 1.5);
    const cursor = first.json('nextCursor');
    if (cursor) {
      getBoard(`${base}/teams?cursor=${encodeURIComponent(cursor)}`, cookie, 'board/teams?cursor');
      think(0.5, 1.5);
    }
  });

  group('filter', () => {
    const skill = SKILLS[Math.floor(Math.random() * SKILLS.length)];
    getBoard(`${base}/teams?skill=${skill}`, cookie, 'board/teams?skill');
    think(0.5, 1.5);
  });

  group('people', () => {
    const first = getBoard(`${base}/people`, cookie, 'board/people');
    think(0.5, 1.5);
    const skill = SKILLS[Math.floor(Math.random() * SKILLS.length)];
    getBoard(`${base}/people?skill=${skill}`, cookie, 'board/people?skill');
    const cursor = first.json('nextCursor');
    if (cursor) {
      think(0.5, 1.5);
      getBoard(
        `${base}/people?cursor=${encodeURIComponent(cursor)}`,
        cookie,
        'board/people?cursor',
      );
    }
    think(0.5, 1.5);
  });
}

function write(method, path, body, cookie, name) {
  const res = http.request(method, `${BASE_URL}${path}`, JSON.stringify(body), {
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': `k6-${__VU}-${__ITER}-${name.replace('/', '-')}-${Date.now()}`,
    },
    tags: { name },
  });
  writeLatency.add(res.timings.duration);
  if (res.status < 300) writesDone.add(1);
  return res;
}

// A writer forms a team, edits it, mints an invite, then dissolves it by leaving.
export function churnTeams(data) {
  const cookie = signedIn('writer');
  const created = write(
    'POST',
    `/api/hackathons/${data.hackathonId}/teams`,
    { name: `Load ${__VU}-${__ITER}-${Date.now() % 100000}`, lookingFor: ['design'] },
    cookie,
    'teams/create',
  );
  // Left over from an aborted earlier run: this account still has a team. Leave it and move on.
  if (created.status === 409) {
    const me = http.get(`${BASE_URL}/api/hackathons/${data.hackathonId}/me`, {
      headers: { Cookie: cookie },
      tags: { name: 'me' },
    });
    const stale = me.json('team.id');
    if (stale) write('POST', `/api/teams/${stale}/leave`, {}, cookie, 'teams/leave');
    return;
  }
  check(created, { 'team created': (r) => r.status === 201 });
  const teamId = created.json('team.id');
  think(0.3, 0.8);
  write(
    'PATCH',
    `/api/teams/${teamId}`,
    { description: 'updated under load' },
    cookie,
    'teams/update',
  );
  think(0.3, 0.8);
  write('POST', `/api/teams/${teamId}/invites`, { expiresInMinutes: 10 }, cookie, 'invites/create');
  think(0.3, 0.8);
  const left = write('POST', `/api/teams/${teamId}/leave`, {}, cookie, 'teams/leave');
  check(left, { 'team dissolved': (r) => r.status === 200 && r.json('teamDeleted') === true });
  think(0.3, 0.8);
}

function ms(value) {
  return value === undefined ? '-' : `${value.toFixed(1)} ms`;
}

function row(label, trend) {
  const v = trend.values;
  return `| ${label} | ${ms(v.med)} | ${ms(v['p(90)'])} | ${ms(v['p(95)'])} | ${ms(v['p(99)'])} | ${ms(v.max)} |`;
}

export function handleSummary(data) {
  const m = data.metrics;
  const seconds = data.state.testRunDurationMs / 1000;
  const passed = Object.values(m).every((metric) =>
    Object.values(metric.thresholds || {}).every((threshold) => threshold.ok),
  );
  const lines = [
    `### ${MODE === 'saturate' ? 'Saturation run (no think time)' : 'Steady run (realistic think time)'}`,
    '',
    `- Target: \`${BASE_URL}\``,
    `- Virtual users: ${READERS} readers + ${WRITERS} writers, ${RAMP} ramp-up then ${DURATION} at full load`,
    `- Requests: ${m.http_reqs.values.count} total, ${m.http_reqs.values.rate.toFixed(1)} req/s`,
    `- Board requests: ${m.board_requests.values.count} (${(m.board_requests.values.count / seconds).toFixed(1)} req/s)`,
    `- Writes committed: ${m.writes_done ? m.writes_done.values.count : 0}`,
    `- Failed requests: ${(m.http_req_failed.values.rate * 100).toFixed(3)} %`,
    `- Checks passed: ${(m.checks.values.rate * 100).toFixed(3)} %`,
    `- Thresholds: ${passed ? 'all passed' : 'FAILED'}`,
    '',
    '| Metric | median | p90 | p95 | p99 | max |',
    '| --- | --- | --- | --- | --- | --- |',
    row('Board endpoints (all)', m.board_latency),
    ...(m.write_latency ? [row('Writes (create, update, invite, leave)', m.write_latency)] : []),
    row('All HTTP requests', m.http_req_duration),
    '',
  ];
  const text = lines.join('\n');
  return {
    stdout: `\n${text}\n`,
    [`loadtest/results/${MODE}.md`]: text,
    [`loadtest/results/${MODE}.json`]: JSON.stringify(data, null, 2),
  };
}
