// Shows, side by side, why the seat claim is written the way it is.
//
//   node scripts/race-demo.js            # 50 people, 1 seat, 20 rounds
//
// Round after round, 50 simulated people try to take the last seat in a team:
//   naive    reads the team, checks there is room in JavaScript, then writes
//   atomic   puts the check inside the write (the approach used by the real service)
// The naive version oversells the seat; the atomic one never does.

import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lastseat?replicaSet=rs0';
const CONTENDERS = Number(process.argv[2] ?? 50);
const ROUNDS = Number(process.argv[3] ?? 20);

const client = new MongoClient(uri, { maxPoolSize: CONTENDERS });
await client.connect();
const teams = client.db().collection('race_demo_teams');
await teams.deleteMany({});

const freshTeam = async () => {
  const team = { members: ['leader', 'm2', 'm3'], memberCount: 3, maxSize: 4, openSeats: 1 };
  const { insertedId } = await teams.insertOne(team);
  return insertedId;
};

async function naiveJoin(teamId, user) {
  const team = await teams.findOne({ _id: teamId });
  if (team.memberCount >= team.maxSize) return false; // looks safe...
  // ...but 49 other requests ran the same check before any of them wrote.
  await teams.updateOne(
    { _id: teamId },
    { $push: { members: user }, $inc: { memberCount: 1, openSeats: -1 } },
  );
  return true;
}

async function atomicJoin(teamId, user) {
  const result = await teams.updateOne(
    { _id: teamId, openSeats: { $gt: 0 }, members: { $ne: user } },
    { $push: { members: user }, $inc: { memberCount: 1, openSeats: -1 } },
  );
  return result.modifiedCount === 1;
}

async function run(label, join) {
  let oversoldRounds = 0;
  let worst = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const teamId = await freshTeam();
    const results = await Promise.all(
      Array.from({ length: CONTENDERS }, (_, i) => join(teamId, `user-${i}`)),
    );
    const winners = results.filter(Boolean).length;
    const team = await teams.findOne({ _id: teamId });
    if (team.memberCount > team.maxSize) oversoldRounds += 1;
    worst = Math.max(worst, winners);
  }
  console.log(
    `${label.padEnd(7)} ${ROUNDS} rounds x ${CONTENDERS} people for 1 seat -> ` +
      `oversold in ${oversoldRounds} rounds, most "winners" in one round: ${worst}`,
  );
}

await run('naive', naiveJoin);
await run('atomic', atomicJoin);

await teams.drop();
await client.close();
