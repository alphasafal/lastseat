# Load-test report

**Result:** with 100 concurrent users on the board and 10 more creating and dissolving teams,
the board endpoints answer with a **p95 of 7.7 ms** (target: under 200 ms), no failed
requests, and every data invariant intact afterwards. With think time removed, the same 100
users push 977 board requests per second at a p95 of 175 ms.

All numbers below were produced by the scripts in [`loadtest/`](../loadtest) against the
code in this repository. The raw k6 summaries are in [`loadtest/results/`](../loadtest/results).

## Setup

|          |                                                                                   |
| -------- | --------------------------------------------------------------------------------- |
| Data     | `npm run seed`: 10,000 users, 2,000 teams (509 full), 4,743 people looking        |
| Machine  | one virtual machine, 2 vCPU (Intel Xeon 2.1 GHz), 7.8 GB RAM, Linux               |
| Software | Node.js 22.23, MongoDB 8.3.7 as a one-node replica set, k6 1.2.3                  |
| Server   | one Node process, `NODE_ENV=production`, gzip on, default rate limits (see below) |
| Topology | server, database and load generator all on the same machine, over loopback        |

Two things to keep in mind when reading the numbers:

- The three processes share two cores, so the load generator competes with the system under
  test. This makes the saturation numbers pessimistic.
- Loopback has no network latency. A deployed instance adds the round trip to the user and to
  the database. I have not run k6 against the hosted demo (Vercel Hobby with a free MongoDB
  Atlas cluster): Atlas limits a free cluster to 100 operations a second, so the result would
  describe the hosting plan rather than the design. What that limit does to the 50-way race is
  measured in section 5. The command to run k6 against any URL is at the end.

Rate limits: the per-user API limit (600 requests per minute) and the invite and login limits
were left at their defaults for the steady run. `RATE_AUTH_PER_IP` was raised because all
virtual users sign in from one IP address. For the saturation runs the per-user API limit was
lifted, since a client with no think time exceeds it by design.

## 1. Steady: 100 people browsing, 10 people writing

`k6 run loadtest/board.js`

Each of 100 virtual users signs in as a different seeded account and loops through what a
person does on the board: open the teams tab, scroll to the next page, filter by a skill,
switch to people, filter, scroll, with 0.5 to 1.5 s of think time between steps. Meanwhile 10
other users create a team, edit it, mint an invite code and dissolve it, over and over, so the
board is read while transactions, audit writes and live events are flowing. Users ramp up over
10 s and stay for 2 minutes.

| Metric                                 | median  | p90     | **p95**    | p99     | max      |
| -------------------------------------- | ------- | ------- | ---------- | ------- | -------- |
| Board endpoints (teams and people)     | 2.8 ms  | 5.6 ms  | **7.7 ms** | 15.6 ms | 73.3 ms  |
| Writes (create, update, invite, leave) | 11.6 ms | 18.9 ms | 24.7 ms    | 36.0 ms | 172.0 ms |

- 15,062 requests in total, 12,738 of them board requests (93 per second)
- 2,212 writes committed
- 0 failed requests, 100 % of checks passed, all thresholds passed
- `npm run verify` afterwards: all invariants hold

## 2. Saturation: the same users with no think time

`k6 run -e MODE=saturate -e DURATION=1m loadtest/board.js`

Every virtual user sends its next request the moment the previous one returns. This is the
strictest reading of "100 concurrent users", and it includes the 10 writers hammering as well,
which keeps emptying the board cache.

| Metric                                 | median   | p90      | **p95**      | p99      | max       |
| -------------------------------------- | -------- | -------- | ------------ | -------- | --------- |
| Board endpoints (teams and people)     | 84.2 ms  | 151.3 ms | **174.6 ms** | 240.3 ms | 682.7 ms  |
| Writes (create, update, invite, leave) | 245.1 ms | 412.6 ms | 481.7 ms     | 701.0 ms | 1056.5 ms |

- 68,868 board requests (977 per second), 2,408 writes committed
- 0 failed requests, all thresholds passed, all invariants hold afterwards

At this point the machine is out of CPU: latency here is queueing time, not query time.

## 3. autocannon, 100 connections on one endpoint

`autocannon -c 100 -d 30 -H "cookie: sid=..." http://127.0.0.1:4000/api/hackathons/<id>/board/teams`

A lighter load generator, reads only, for comparison with other submissions that use
autocannon.

|         | 2.5 % | median | 97.5 % | 99 %  | average |
| ------- | ----- | ------ | ------ | ----- | ------- |
| Latency | 10 ms | 18 ms  | 39 ms  | 45 ms | 19.6 ms |

150,000 requests in 30 s, 4,988 per second on average. One request took 1.5 s (the maximum);
the 99th percentile is 45 ms.

## 4. Live updates: commit to screen

`node loadtest/live-latency.js`

300 server-sent-event streams are held open while 4 writers change teams for 20 s. For every
event received, the script records the time from the server's timestamp on the change to its
arrival on the stream. That covers the transaction, the change-stream hop and the fan-out.

| Streams | Events delivered           | median | p95   | p99   | max    |
| ------- | -------------------------- | ------ | ----- | ----- | ------ |
| 300     | 596,400 of 596,400 (100 %) | 17 ms  | 34 ms | 55 ms | 112 ms |

## 5. The 50-way race on a rate-limited database

The race lab (`POST /api/lab/race`, the button on the landing page) times 50 simultaneous
joins for one seat. On the machine above it takes about 0.3 s. On the hosted demo the first
version took 7.4 s, close enough to the 8 s transaction deadline that a slower run could have
ended in `503 BUSY` instead of `TEAM_FULL`.

The cause was not contention. A free Atlas cluster accepts about 100 operations a second, and
the run sent about 740: each of the 49 losers made three attempts of five operations each.
The third attempt was pure waste. A retry only helps after the winner has committed, the
winner's own operations were queued behind everyone else's, and the backoff (at most 100 ms)
was tuned for a database that answers in a millisecond.

Two changes followed. Redeeming a code no longer loads the hackathon for someone who is
already registered, which removed one operation per attempt (hosted: 6.0 to 6.4 s). And the
wait before a retry is now as long as the failed attempt took (`retryDelayMs` in
[`db.js`](../server/src/db.js)), so it adapts to how fast the database is.

To measure the second change without deploying,
[`loadtest/throttle-proxy.js`](../loadtest/throttle-proxy.js) puts the same limit in front of
a local mongod. It reproduced the hosted numbers before the change and predicted them after:

| 50 joins, 1 seat                        | Local, no limit          | Local, 100 ops/s proxy   | Hosted demo                 |
| --------------------------------------- | ------------------------ | ------------------------ | --------------------------- |
| Backoff of at most 250 ms               | 0.3 s, 64-88 retries     | 6.6 to 6.8 s, 98 retries | 6.0 to 6.4 s, 98 retries    |
| Wait as long as the failed attempt took | 0.3 to 0.4 s, 49 retries | 5.0 to 5.1 s, 49 retries | 3.6 to 5.0 s, 51-76 retries |

49 retries is the floor: 49 requests have to lose once before they can be told the team is
full. What remains on the hosted demo is the limit itself (about 400 operations at 100 a
second). The result of every run, before and after, was the same: one join, 49 `TEAM_FULL`,
all six stored-data checks passing. The hosted demo also raises the deadline to 25 s
(`TXN_DEADLINE_MS`), so a slow run is slow instead of wrong.

## What the load test changed

The first version of the board had no cache. I ran the saturation scenario early and it
failed the target, so the numbers above are the result of three changes, each measured on the
same machine (100 connections, no think time):

| Change                                                               | Board throughput | p95    |
| -------------------------------------------------------------------- | ---------------- | ------ |
| Starting point: every request queries MongoDB and gzips a 19 kB page | 225 req/s        | 433 ms |
| Encode and gzip each page once, share it, empty it on every change   | 546 req/s        | 201 ms |
| Trust a verified session for 10 s instead of one lookup per request  | 1,041 req/s      | 119 ms |

Those three rows are reads only. Adding the 10 writers back, the cache was being emptied by
events that cannot affect the board (invite codes, join requests):

| Change                                               | Board throughput | p95    |
| ---------------------------------------------------- | ---------------- | ------ |
| Every event empties every page                       | 803 req/s        | 203 ms |
| An event empties only the kind of page it can affect | 909 req/s        | 185 ms |

(The run reported in section 2 is a later one on the final code: 977 req/s, p95 175 ms.)

The query itself was never the problem. `explain()` for a board page of 24 rows shows 25 index
keys and 25 documents examined: the partial indexes contain only teams with open seats and
people who are looking, and pagination is by cursor, so page 300 costs the same as page 1.

The test also caught a bug in the test. My first k6 script indexed a shared list of sessions
by `__VU`, which let two writers use the same account and dissolve each other's teams: 3 % of
requests failed with 404 and 409. The server was right to refuse them. Each virtual user now
derives its own account from its test-wide id.

## Reproduce

```bash
npm run seed -- --reset
RATE_AUTH_PER_IP=100000 NODE_ENV=production npm start

k6 run loadtest/board.js                                   # section 1
npm run verify

# restart with the per-user API limit lifted, then:
RATE_API_PER_USER=100000000 RATE_AUTH_PER_IP=100000 NODE_ENV=production npm start
k6 run -e MODE=saturate -e DURATION=1m loadtest/board.js   # section 2
node loadtest/live-latency.js                              # section 4

# against a deployed instance (seed it first):
k6 run -e BASE_URL=https://your-app.example loadtest/board.js

# section 5: the same server behind a database limited to 100 operations a second
node loadtest/throttle-proxy.js &
MONGODB_URI='mongodb://127.0.0.1:27018/lastseat?directConnection=true' PORT=4001 npm start
curl -X POST localhost:4001/api/lab/race -H 'content-type: application/json' -d '{}'
```
