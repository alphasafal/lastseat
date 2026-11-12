import { col, toObjectId } from './db.js';
import { errors, isDuplicateKey } from './lib/errors.js';

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
  return col
    .hackathons()
    .find({ hidden: { $ne: true } })
    .sort({ startsAt: 1 })
    .limit(50)
    .toArray();
}

const LAB_SLUG = 'race-lab';

/**
 * The hidden hackathon the race lab runs in. It never shows up in listings, so lab runs
 * cannot touch a real board. Created on first use.
 */
export async function getLabHackathon() {
  const hit = cache.get(LAB_SLUG);
  if (hit) return hit.doc;
  const fields = {
    slug: LAB_SLUG,
    name: 'Race lab',
    tagline: '',
    hidden: true,
    minTeamSize: 2,
    maxTeamSize: 4,
    startsAt: new Date(),
    createdAt: new Date(),
  };
  let doc;
  try {
    doc = await col
      .hackathons()
      .findOneAndUpdate(
        { slug: LAB_SLUG },
        { $setOnInsert: fields },
        { upsert: true, returnDocument: 'after' },
      );
  } catch (err) {
    // Two first-ever runs at once: the other one created it.
    if (!isDuplicateKey(err)) throw err;
    doc = await col.hackathons().findOne({ slug: LAB_SLUG });
  }
  cache.set(LAB_SLUG, { doc, until: Infinity });
  return doc;
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
