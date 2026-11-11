import { col, toObjectId } from './db.js';
import { errors } from './lib/errors.js';

// Team-size rules change rarely and are read on every request, so they are cached briefly.
const CACHE_MS = 30_000;
const cache = new Map();

export async function getHackathon(id) {
  const key = String(id);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.doc;
  const doc = await col.hackathons().findOne({ _id: toObjectId(key) });
  if (!doc) throw errors.notFound('Hackathon');
  cache.set(key, { doc, until: Date.now() + CACHE_MS });
  return doc;
}

export async function listHackathons() {
  return col.hackathons().find().sort({ startsAt: 1 }).limit(50).toArray();
}

/** Creates the demo hackathon on first boot so a fresh deployment is usable immediately. */
export async function ensureDefaultHackathon() {
  const now = new Date();
  await col.hackathons().updateOne(
    { slug: 'winter-build-2026' },
    {
      $setOnInsert: {
        slug: 'winter-build-2026',
        name: 'Winter Build 2026',
        tagline: '48 hours, 10,000 builders, teams of 2 to 4.',
        minTeamSize: 2,
        maxTeamSize: 4,
        startsAt: new Date('2026-12-05T04:30:00Z'),
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

export function clearHackathonCache() {
  cache.clear();
}
