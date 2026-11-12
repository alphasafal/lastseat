# Design

One page on how Lastseat stores teams, why two people can never take the same seat, and what
I traded away to get there.

## Data model

MongoDB, ten collections. The three that matter:

- **`teams`**: one document per team with its members embedded (at most `maxSize` of them),
  plus `memberCount`, `openSeats`, `leaderId` and a `version` that increases on every change.
  A team is small and always read whole, so it is one document, and one document is the unit
  MongoDB updates atomically.
- **`participants`**: one row per person per hackathon: skills, time zone, `lookingForTeam`
  and a copy of `teamId`. This is the "people looking" board and the input to suggestions.
- **`audit_log`**: append-only: who, what, when, plus a snapshot of the team after the
  change. It is also the event stream for live updates.

Around them: `invites` (SHA-256 of the code, `expiresAt`, `revokedAt`), `join_requests`,
`idempotency_keys`, `rate_limits`, `sessions`, `users`, `hackathons`.

## How races are prevented

**The last seat.** A seat is taken by a single conditional update:
`findOneAndUpdate({ _id, openSeats: { $gt: 0 }, 'members.userId': { $ne: me } }, { $push, $inc })`.
The check is inside the write. MongoDB applies writes to one document one at a time, so of 50
simultaneous joins exactly one matches `openSeats > 0`; the other 49 match nothing and get
`TEAM_FULL`.

**One team per person.** A unique multikey index on `(hackathonId, members.userId)`. A second
team containing the same person cannot be written, by a join, by a create or by a bug.

**Everything else that belongs to a join** (the participant row, withdrawing the person's
other requests, the audit entry, the idempotency record) is written in the same transaction
as the claim. Losers of a race get a write conflict, roll back and run again against the new
state. Before retrying they wait about as long as the failed attempt took, so each loser needs
one retry whether the database answers in a millisecond or is rate-limited.

**Retries.** A write may carry an `Idempotency-Key`. Its result is stored in the same
transaction as the change, so a retry or a double click replays the first response. Joining
is also idempotent without a key: joining a team you are in is a no-op.

**Authorization races.** "Only the leader" is part of the write filter (`leaderId: actor`),
not a check before it. Leave and remove write with the `version` they read.

**Counted limits** (5 pending requests, 5 active codes) first write to one shared document,
which makes concurrent attempts conflict and therefore run one after another.

**Proof.** `race.test.js` fires real concurrent HTTP requests: 50 for one seat, 40 for three,
10 parallel accepts, one person into two teams, 20 simultaneous creates, last member leaving
against 20 joins, and a mixed storm. After each it runs an invariant checker over the whole
database. `chaos.test.js` kills the server between the claim and the commit. The live site
has a button that runs the 50-way race on the production database and shows the result.

## Trade-offs

| Decision                                                     | What I gave up                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions for the bookkeeping                             | Needs a replica set. If a server dies mid-transaction MongoDB keeps that team write-locked until the transaction times out (60 s default; I measured 77 s). I bound it: after 8 s the request returns a retryable `503 BUSY`. Nothing is corrupted. |
| Audit log doubles as the event bus (change stream, no Redis) | Events reach every instance and only after commit, but log retention and delivery are now coupled, and each instance holds a change stream.                                                                                                         |
| SSE instead of WebSockets                                    | One direction is all the board needs and reconnecting is built in. A reconnecting client refetches rather than replaying missed events.                                                                                                             |
| Board pages cached, emptied by the same events               | Exact on one instance. With several instances a page can lag by the few milliseconds of skew between their change streams, capped by a 2 s TTL.                                                                                                     |
| Sessions trusted for 10 s                                    | A logout takes up to 10 s to reach other instances. In return a board read makes no session query.                                                                                                                                                  |
| Member names and skills copied into the team                 | Board reads need no join; profile edits must update two documents (done in one transaction).                                                                                                                                                        |
| Invite codes stored only as a hash                           | A leaked database gives no usable codes; the leader sees a code once and must create a new one if it is lost.                                                                                                                                       |
| Minimum size is a status, not a gate                         | A team below the minimum exists as "forming". Blocking it would make starting a team impossible.                                                                                                                                                    |
| Only successful results are remembered for idempotency       | A failed request runs again on retry. It changed nothing, so that is safe and returns the current truth.                                                                                                                                            |
| Suggestions score a pool of 500                              | Not all 10,000 people are scored per request; the pool is narrowed in the database by wanted skill and recent activity.                                                                                                                             |

Invite codes: 12 symbols of Crockford base32 are 60 bits (about 10^18 codes). At 10 guesses
per 10 minutes per account, hitting any one of 2,000 live codes takes an attacker about a
billion years per account.

## With one more week

1. Remove the 60 s lock after a crash: commit the seat with the single-document write alone
   and move the bookkeeping to an outbox inside the team document, drained by a relay.
2. Replay missed events on reconnect using `Last-Event-ID` and the audit log.
3. Run the browser flow in CI, and a nightly soak of the race tests.
4. Organizer tools: change size limits, lock teams at the deadline, export.
5. A shared store for the general rate limit, and load tests against a multi-instance deploy.
