// A stand-in for a rate-limited MongoDB cluster, for testing on one machine.
//
// It sits between the server and mongod and forwards the wire protocol unchanged, but lets
// through at most OPS_PER_SEC client messages per second, counted across all connections.
// Free shared clusters behave like this (MongoDB Atlas M0: 100 operations a second), and it
// changes which retry strategy is fast. See section 5 of docs/LOAD_TEST_REPORT.md.
//
//   node loadtest/throttle-proxy.js
//   MONGODB_URI='mongodb://127.0.0.1:27018/lastseat?directConnection=true' npm start

import net from 'node:net';

const OPS_PER_SEC = Number(process.env.OPS_PER_SEC ?? 100);
const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 27018);
const MONGO_PORT = Number(process.env.MONGO_PORT ?? 27017);

// One queue for every connection: the limit is on the cluster, not on a client.
const queue = [];
setInterval(() => queue.shift()?.(), 1000 / OPS_PER_SEC);

net
  .createServer((client) => {
    const mongod = net.connect(MONGO_PORT, '127.0.0.1');
    mongod.pipe(client); // replies are not delayed

    // Every wire-protocol message starts with its own length (int32, little endian), so the
    // stream can be cut into whole messages without understanding them.
    let pending = Buffer.alloc(0);
    client.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
        const length = pending.readInt32LE(0);
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        queue.push(() => mongod.writable && mongod.write(message));
      }
    });

    const close = () => {
      client.destroy();
      mongod.destroy();
    };
    for (const socket of [client, mongod]) socket.on('error', close).on('close', close);
  })
  .listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`forwarding 127.0.0.1:${LISTEN_PORT} to mongod at ${OPS_PER_SEC} operations/s`);
  });
