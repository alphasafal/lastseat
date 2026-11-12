import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { retryDelayMs } from '../src/db.js';

// The wait before a rolled-back transaction runs again. It is random, so each property is
// checked over many draws.
const draws = (attempt, lastAttemptMs) =>
  Array.from({ length: 500 }, () => retryDelayMs(attempt, lastAttemptMs));

describe('retry delay', () => {
  test('a fast failed attempt waits for the exponential floor: 20-40 ms, then 40-80 ms', () => {
    for (const ms of draws(2, 3)) assert.ok(ms >= 20 && ms <= 40, `attempt 2 waited ${ms}`);
    for (const ms of draws(3, 3)) assert.ok(ms >= 40 && ms <= 80, `attempt 3 waited ${ms}`);
  });

  test('the floor stops growing at 250 ms', () => {
    for (const ms of draws(12, 3)) assert.ok(ms >= 125 && ms <= 250, `waited ${ms}`);
  });

  test('a slow failed attempt waits about as long as it took', () => {
    for (const ms of draws(2, 1200)) assert.ok(ms >= 600 && ms <= 1200, `waited ${ms}`);
  });

  test('the wait never exceeds 2 s, however slow the attempt was', () => {
    for (const ms of draws(2, 60_000)) assert.ok(ms >= 1000 && ms <= 2000, `waited ${ms}`);
  });

  test('two losers of the same race do not come back at the same moment', () => {
    assert.ok(new Set(draws(2, 1200).map(Math.round)).size > 100);
  });
});
