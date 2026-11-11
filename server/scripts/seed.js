// Seeds a hackathon at the scale the brief asks for: 10,000 registered users and 2,000 teams.
//
//   npm run seed                      # 10,000 users, 2,000 teams
//   npm run seed -- --users 500 --teams 100
//   npm run seed -- --reset           # wipe seeded data first
//
// The data is generated from a fixed random seed, so two runs produce the same hackathon and
// load-test numbers are comparable between runs.

import { parseArgs } from 'node:util';
import { SKILLS } from '../src/config.js';
import { ObjectId, col, connect, db, disconnect, ensureIndexes } from '../src/db.js';
import { hashPassword } from '../src/auth/password.js';
import { auditEntry } from '../src/lib/audit.js';
import { checkInvariants } from '../src/lib/invariants.js';
import { utcOffsetMinutes } from '../src/lib/time.js';

const { values: args } = parseArgs({
  options: {
    users: { type: 'string', default: '10000' },
    teams: { type: 'string', default: '2000' },
    reset: { type: 'boolean', default: false },
    slug: { type: 'string', default: 'winter-build-2026' },
  },
});
const USERS = Number(args.users);
const TEAMS = Number(args.teams);
export const SEED_PASSWORD = 'hackathon-demo';
const EMAIL_DOMAIN = 'seed.lastseat.test';

// mulberry32: a tiny deterministic PRNG, good enough for generating demo data.
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(20261115);
const pick = (list) => list[Math.floor(random() * list.length)];
function sample(list, n) {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return out;
}

const FIRST = [
  'Aarav',
  'Aditi',
  'Akira',
  'Amara',
  'Ananya',
  'Arjun',
  'Bao',
  'Camila',
  'Chen',
  'Dev',
  'Diya',
  'Elena',
  'Emeka',
  'Farah',
  'Hana',
  'Ishaan',
  'Jin',
  'Kabir',
  'Kavya',
  'Lars',
  'Leila',
  'Mateo',
  'Meera',
  'Nia',
  'Noor',
  'Omar',
  'Priya',
  'Rahul',
  'Riya',
  'Rohan',
  'Sana',
  'Sofia',
  'Tariq',
  'Tara',
  'Vikram',
  'Wei',
  'Yuki',
  'Zainab',
  'Zoe',
  'Neha',
];
const LAST = [
  'Agarwal',
  'Ali',
  'Banerjee',
  'Chowdhury',
  'Costa',
  'Das',
  'Fernandez',
  'Garcia',
  'Gupta',
  'Iyer',
  'Jain',
  'Khan',
  'Kim',
  'Kumar',
  'Mehta',
  'Nair',
  'Nguyen',
  'Okafor',
  'Patel',
  'Rao',
  'Reddy',
  'Sato',
  'Shah',
  'Sharma',
  'Singh',
  'Tanaka',
  'Verma',
  'Wang',
  'Yadav',
  'Zhang',
];
// Weighted towards India, where most participants of the target hackathons are.
const ZONES = [
  ...Array(10).fill('Asia/Kolkata'),
  'Asia/Singapore',
  'Asia/Dubai',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Berlin',
  'Africa/Lagos',
  'America/New_York',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
];
const ADJECTIVES = [
  'Async',
  'Binary',
  'Cosmic',
  'Electric',
  'Fuzzy',
  'Hidden',
  'Lazy',
  'Lucky',
  'Midnight',
  'Neon',
  'Quantum',
  'Rapid',
  'Silent',
  'Solar',
  'Turbo',
  'Velvet',
];
const NOUNS = [
  'Badgers',
  'Coders',
  'Falcons',
  'Foxes',
  'Hackers',
  'Koalas',
  'Lambdas',
  'Monads',
  'Ninjas',
  'Otters',
  'Pandas',
  'Pilots',
  'Pixels',
  'Rockets',
  'Tigers',
  'Wizards',
];
const HEADLINES = [
  'Looking for a team that ships.',
  'First hackathon, fast learner.',
  'Happy to own the backend.',
  'I make demos look good.',
  'Can pitch, can code, will stay up.',
  'Want to build something for farmers.',
  '',
  '',
];

async function insertInBatches(collection, docs, size = 2000) {
  for (let i = 0; i < docs.length; i += size) {
    await collection.insertMany(docs.slice(i, i + size), { ordered: false });
  }
}

async function main() {
  if (TEAMS > USERS) throw new Error('--teams cannot exceed --users');
  await connect();
  await ensureIndexes();
  const started = Date.now();
  const now = new Date();

  let hackathon = await col.hackathons().findOne({ slug: args.slug });
  if (!hackathon) {
    hackathon = {
      _id: new ObjectId(),
      slug: args.slug,
      name: 'Winter Build 2026',
      tagline: '48 hours, 10,000 builders, teams of 2 to 4.',
      minTeamSize: 2,
      maxTeamSize: 4,
      startsAt: new Date('2026-12-05T04:30:00Z'),
      createdAt: now,
    };
    await col.hackathons().insertOne(hackathon);
  }

  const already = await col.users().countDocuments({ seeded: true });
  if (already > 0 && !args.reset) {
    console.log(`Found ${already} seeded users. Run with --reset to replace them.`);
    await disconnect();
    return;
  }
  if (args.reset) {
    const seededIds = await col.users().distinct('_id', { seeded: true });
    const scope = { hackathonId: hackathon._id };
    await Promise.all([
      col.teams().deleteMany(scope),
      col.participants().deleteMany(scope),
      col.invites().deleteMany(scope),
      col.joinRequests().deleteMany(scope),
      col.audit().deleteMany(scope),
      col.sessions().deleteMany({ userId: { $in: seededIds } }),
      col.users().deleteMany({ seeded: true }),
    ]);
    console.log('Removed previous seed data.');
  }

  // One hash for every seeded account: hashing 10,000 passwords would take ten minutes and
  // these are demo accounts with a published password.
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const offsets = new Map(ZONES.map((zone) => [zone, utcOffsetMinutes(zone, now)]));

  const users = [];
  const participants = [];
  for (let i = 1; i <= USERS; i += 1) {
    const _id = new ObjectId();
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const timezone = pick(ZONES);
    const skills = sample(SKILLS, 1 + Math.floor(random() * 4));
    // Spread "last active" over the past three days so the board has a realistic order.
    const updatedAt = new Date(now.getTime() - Math.floor(random() * 72 * 3600_000));
    users.push({
      _id,
      email: `user${String(i).padStart(5, '0')}@${EMAIL_DOMAIN}`,
      name,
      skills,
      timezone,
      passwordHash,
      seeded: true,
      createdAt: updatedAt,
    });
    participants.push({
      _id: new ObjectId(),
      hackathonId: hackathon._id,
      userId: _id,
      name,
      skills,
      headline: pick(HEADLINES),
      timezone,
      utcOffsetMinutes: offsets.get(timezone),
      lookingForTeam: true,
      teamId: null,
      createdAt: updatedAt,
      updatedAt,
    });
  }
  users.push({
    _id: new ObjectId(),
    email: `organizer@${EMAIL_DOMAIN}`,
    name: 'Olivia Organizer',
    skills: ['product'],
    timezone: 'Asia/Kolkata',
    passwordHash,
    role: 'organizer',
    seeded: true,
    createdAt: now,
  });

  // Team sizes: a quarter full, the rest with one to three open seats.
  const teams = [];
  const audit = [];
  const usedNames = new Set();
  let cursor = 0;
  for (let t = 0; t < TEAMS; t += 1) {
    const roll = random();
    const wanted = roll < 0.25 ? 4 : roll < 0.55 ? 3 : roll < 0.8 ? 2 : 1;
    // Never run out of people: later teams shrink if the pool is nearly used up.
    const size = Math.max(1, Math.min(wanted, USERS - cursor - (TEAMS - t - 1)));
    const members = participants.slice(cursor, cursor + size);
    cursor += size;

    let name;
    do {
      name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${Math.floor(random() * 900) + 100}`;
    } while (usedNames.has(name));
    usedNames.add(name);

    const updatedAt = new Date(now.getTime() - Math.floor(random() * 48 * 3600_000));
    const have = new Set(members.flatMap((member) => member.skills));
    const team = {
      _id: new ObjectId(),
      hackathonId: hackathon._id,
      name,
      nameKey: name.toLowerCase(),
      description: 'Seeded team for load testing.',
      lookingFor:
        size < 4
          ? sample(
              SKILLS.filter((skill) => !have.has(skill)),
              2,
            )
          : [],
      leaderId: members[0].userId,
      members: members.map((member, index) => ({
        userId: member.userId,
        name: member.name,
        skills: member.skills,
        utcOffsetMinutes: member.utcOffsetMinutes,
        joinedAt: new Date(updatedAt.getTime() + index * 60_000),
      })),
      memberCount: size,
      minSize: hackathon.minTeamSize,
      maxSize: hackathon.maxTeamSize,
      openSeats: hackathon.maxTeamSize - size,
      acceptingRequests: true,
      version: size,
      createdAt: updatedAt,
      updatedAt,
    };
    teams.push(team);
    for (const member of members) {
      member.teamId = team._id;
      member.lookingForTeam = false;
    }
    // One entry per seeded team so the audit log still adds up to the member count.
    const entry = auditEntry({
      type: 'team.created',
      hackathonId: hackathon._id,
      teamId: team._id,
      actor: { userId: members[0].userId, name: members[0].name },
      data: { name, seeded: true, seededMembers: size },
      at: updatedAt,
    });
    audit.push(entry);
  }

  await insertInBatches(col.users(), users);
  await insertInBatches(col.participants(), participants);
  await insertInBatches(col.teams(), teams);
  await insertInBatches(col.audit(), audit);

  const report = await checkInvariants(db(), { hackathonId: hackathon._id });
  console.log(
    [
      `Seeded "${hackathon.name}" in ${((Date.now() - started) / 1000).toFixed(1)} s`,
      `  users         ${USERS} (+1 organizer)`,
      `  teams         ${teams.length} (${report.stats.fullTeams} full)`,
      `  seated        ${report.stats.seated}`,
      `  looking       ${USERS - report.stats.seated}`,
      `  invariants    ${report.ok ? 'OK' : `VIOLATED\n${report.violations.join('\n')}`}`,
      '',
      `Sign in as user00001@${EMAIL_DOMAIN} ... user${String(USERS).padStart(5, '0')}@${EMAIL_DOMAIN}`,
      `Password for every seeded account: ${SEED_PASSWORD}`,
    ].join('\n'),
  );
  await disconnect();
  if (!report.ok) process.exit(1);
}

await main();
