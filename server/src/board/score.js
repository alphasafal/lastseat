// Teammate scoring. Pure functions with no I/O, so every number in a suggestion can be
// reproduced by hand and is covered by unit tests (test/suggestions.test.js).

import { formatOffset } from '../lib/time.js';

const MINUTES_PER_DAY = 24 * 60;

/**
 * Minutes per day during which two people are both inside their local active window.
 *
 * Each window is an arc of the same length on a 24-hour circle; shifting one person by the
 * difference of their UTC offsets slides one arc along the circle. Two arcs longer than
 * 12 hours can touch at both ends, which is what the second term accounts for.
 */
export function overlapMinutes(offsetA, offsetB, window) {
  const length = (window.endHour - window.startHour) * 60;
  const diff = Math.abs(offsetA - offsetB) % MINUTES_PER_DAY;
  const shift = Math.min(diff, MINUTES_PER_DAY - diff);
  return Math.max(0, length - shift) + Math.max(0, length - (MINUTES_PER_DAY - shift));
}

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

// How a skill id reads inside a sentence. Only ids that are not already plain words are listed.
const SKILL_NAMES = { ml: 'ML', devops: 'DevOps', gamedev: 'game dev', fullstack: 'full-stack' };
/** "design", "design and ML", "design, ML and DevOps" */
function list(skills) {
  const names = skills.map((skill) => SKILL_NAMES[skill] ?? skill);
  return names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * @param {{have: string[], wanted: string[], offsets: number[]}} context the team (or solo user)
 * @param {{skills: string[], utcOffsetMinutes: number}} candidate
 * @param {{weights: {wanted: number, complementary: number, timezone: number},
 *          activeWindow: {startHour: number, endHour: number}}} options
 */
export function scoreCandidate(context, candidate, options) {
  const have = new Set(context.have);
  const wantedSet = new Set(context.wanted);

  const bringsWanted = candidate.skills.filter((skill) => wantedSet.has(skill));
  const newSkills = candidate.skills.filter((skill) => !have.has(skill));
  const shared = candidate.skills.filter((skill) => have.has(skill));

  const wantedScore = wantedSet.size > 0 ? bringsWanted.length / wantedSet.size : 0;
  const complementaryScore = Math.min(1, newSkills.length / 3);

  const windowMinutes = (options.activeWindow.endHour - options.activeWindow.startHour) * 60;
  const overlaps = context.offsets.map((offset) =>
    overlapMinutes(offset, candidate.utcOffsetMinutes, options.activeWindow),
  );
  const meanOverlap = overlaps.reduce((sum, m) => sum + m, 0) / overlaps.length;
  const timezoneScore = meanOverlap / windowMinutes;

  // With no wanted skills there is nothing to measure, so that weight goes to the other two
  // in proportion instead of silently capping everyone's score.
  const weights = { ...options.weights };
  if (wantedSet.size === 0) {
    const rest = weights.complementary + weights.timezone;
    weights.complementary += weights.wanted * (weights.complementary / rest);
    weights.timezone += weights.wanted * (weights.timezone / rest);
    weights.wanted = 0;
  }

  const score =
    100 *
    (weights.wanted * wantedScore +
      weights.complementary * complementaryScore +
      weights.timezone * timezoneScore);

  const reasons = [];
  if (bringsWanted.length > 0)
    reasons.push(`Brings ${list(bringsWanted)}, which you are looking for.`);
  const extra = newSkills.filter((skill) => !wantedSet.has(skill));
  if (extra.length > 0) reasons.push(`Adds ${list(extra)} - nobody on your side has that yet.`);
  if (newSkills.length === 0) reasons.push('Has the same skills you already cover.');
  const hours = round(meanOverlap / 60, 1);
  reasons.push(
    `${hours} of ${windowMinutes / 60} active hours overlap (${formatOffset(candidate.utcOffsetMinutes)}).`,
  );

  return {
    score: round(score, 1),
    breakdown: {
      wanted: { score: round(wantedScore), weight: round(weights.wanted), skills: bringsWanted },
      complementary: {
        score: round(complementaryScore),
        weight: round(weights.complementary),
        skills: newSkills,
      },
      timezone: {
        score: round(timezoneScore),
        weight: round(weights.timezone),
        overlapHours: hours,
      },
      sharedSkills: shared,
    },
    reasons,
  };
}

/** Scores every candidate and sorts best first. Ties keep the more recently active person first. */
export function rankCandidates(context, candidates, options) {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      ...scoreCandidate(context, candidate, options),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ index: _index, ...rest }) => rest);
}
