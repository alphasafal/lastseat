// Turns a freshly started `mongod --replSet rs0` into a one-node replica set and waits until
// it is primary. Transactions and change streams need a replica set; a single node is enough.
// Safe to run repeatedly. Used by docker-compose, CI and local setup.

import { MongoClient } from 'mongodb';

const host = process.env.MONGO_HOST ?? '127.0.0.1:27017';
// The name other processes will use to reach this node (differs from `host` inside Docker).
const advertised = process.env.MONGO_ADVERTISED_HOST ?? host;
const deadline = Date.now() + 60_000;

const client = new MongoClient(`mongodb://${host}/?directConnection=true`, {
  serverSelectionTimeoutMS: 2000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt() {
  await client.connect();
  const admin = client.db('admin');
  try {
    await admin.command({ replSetGetStatus: 1 });
  } catch (err) {
    if (err.codeName !== 'NotYetInitialized') throw err;
    await admin.command({
      replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: advertised }] },
    });
    console.log(`replica set initiated (${advertised})`);
  }
  const hello = await admin.command({ hello: 1 });
  if (!hello.isWritablePrimary) throw new Error('not primary yet');
}

for (;;) {
  try {
    await attempt();
    console.log('mongodb replica set is ready');
    break;
  } catch (err) {
    if (Date.now() > deadline) {
      console.error(`mongodb did not become ready: ${err.message}`);
      process.exit(1);
    }
    await sleep(1000);
  }
}
await client.close();
