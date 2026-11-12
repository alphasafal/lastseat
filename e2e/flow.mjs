// End-to-end check of the UI in a real browser: three people, live updates, keyboard-only
// use, optimistic rollback and a phone-sized viewport.
//
//   npm run build && npm start          # in one terminal (needs `npm run seed` once)
//   npm run e2e                         # in another
//
// Uses the Chrome that is already installed (CHROME_PATH to override); nothing is downloaded.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4000';
const CHROME =
  process.env.CHROME_PATH ??
  [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find(existsSync);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
  ],
});
const consoleErrors = [];

async function person(viewport = { width: 1280, height: 860 }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
  return page;
}

async function clickText(page, text, selector = 'button, a') {
  const handle = await page.evaluateHandle(
    (wanted, sel) =>
      [...document.querySelectorAll(sel)].find(
        (el) => el.textContent.trim().startsWith(wanted) && !el.disabled,
      ),
    text,
    selector,
  );
  assert.ok(handle.asElement(), `no enabled element starting with "${text}"`);
  await handle.asElement().click();
}

/** Presses Tab until the focused element's text or label starts with `text`. */
async function tabTo(page, text, limit = 80) {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      const labelled = el.labels?.[0]?.textContent ?? '';
      return (el.getAttribute('aria-label') || el.textContent || labelled || '').trim();
    });
    if (label.startsWith(text)) return;
  }
  assert.fail(`could not reach "${text}" with the Tab key`);
}

/** Waits for a condition in the page. Polls on a timer: animation frames stop in background tabs. */
const until = (page, condition) =>
  page.waitForFunction(condition, { polling: 100, timeout: 10_000 });

const memberCount = (page) => page.$$eval('.members .member', (items) => items.length);
const step = (name) => console.log(`ok - ${name}`);

try {
  // --- The race lab on the landing page, without an account ------------------------------
  const visitor = await person();
  assert.equal(
    await visitor.$$eval('.checks-pending li', (items) => items.length),
    6,
    'the six checks are listed before the first run',
  );
  await clickText(visitor, 'Run the race');
  await visitor.waitForSelector('.check-ok', { timeout: 30_000 });
  assert.equal(await visitor.$$eval('.check-ok', (items) => items.length), 6);
  assert.equal(await visitor.$$eval('.check-bad', (items) => items.length), 0);
  assert.equal(await visitor.$$eval('.dot-won', (dots) => dots.length), 1);
  assert.equal(await visitor.$$eval('.dot-full', (dots) => dots.length), 49);
  assert.match(await visitor.$eval('.race-sentence', (el) => el.textContent), /other 49 were told/);
  step('race lab: 50 real joins for one seat, one winner, six checks pass');

  // --- Keyboard only: sign in, create a team, mint an invite code -------------------------
  const leader = await person();
  await tabTo(leader, 'Try a demo account');
  await leader.keyboard.press('Enter');
  await leader.waitForSelector('.rows .row');

  await tabTo(leader, 'Create a team');
  await leader.keyboard.press('Enter');
  await leader.waitForSelector('dialog[open]');
  const teamName = `Keyboard Crew ${Math.floor(Math.random() * 9000) + 1000}`;
  await tabTo(leader, 'Team name');
  await leader.keyboard.type(teamName);
  await tabTo(leader, 'Create team');
  await leader.keyboard.press('Enter');
  await leader.waitForSelector('.team-page');
  assert.equal(await leader.$eval('h1', (h1) => h1.textContent), teamName);

  await tabTo(leader, 'Create invite code');
  await leader.keyboard.press('Enter');
  await leader.waitForSelector('.fresh-code-value');
  const code = await leader.$eval('.fresh-code-value', (el) => el.textContent);
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const teamUrl = leader.url();
  step('keyboard only: demo sign-in, create team, create invite code');

  // Escape closes a dialog and focus returns to the button that opened it.
  await tabTo(leader, 'Leave team');
  await leader.keyboard.press('Enter');
  await leader.waitForSelector('dialog[open]');
  await leader.keyboard.press('Escape');
  await until(leader, () => !document.querySelector('dialog[open]'));
  assert.equal(
    await leader.evaluate(() => document.activeElement.textContent.trim()),
    'Leave team',
  );
  step('dialogs close on Escape and give focus back');

  // --- Live: a request appears for the leader without a refresh ---------------------------
  const phone = await person({ width: 390, height: 800 });
  await clickText(phone, 'Try a demo account');
  await phone.waitForSelector('.rows .row');
  assert.equal(
    await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    'the board must not scroll sideways on a phone',
  );
  await phone.goto(teamUrl, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('.team-page');
  await clickText(phone, 'Ask to join');
  await leader.waitForSelector('.request-row', { timeout: 5000 });
  step('a join request reaches the leader live');

  await clickText(leader, 'Accept');
  await until(phone, () => document.querySelectorAll('.members .member').length === 2);
  assert.equal(
    await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    'the team page must not scroll sideways on a phone',
  );
  step('the accepted person sees their seat fill live, on a phone-sized screen');

  // --- Live: joining with a code updates everyone ----------------------------------------
  const third = await person();
  await clickText(third, 'Try a demo account');
  await third.waitForSelector('.code-form input');
  await third.type('.code-form input', code.toLowerCase());
  await clickText(third, 'Join team');
  await third.waitForSelector('.team-page');
  await until(leader, () => document.querySelectorAll('.members .member').length === 3);
  step('joining with a code (typed in lower case) updates the other members live');

  // --- Optimistic UI with rollback -------------------------------------------------------
  // Two people ask for the one remaining seat. The leader has the page open in two tabs; the
  // second tab is cut off from live updates, so it still shows the seat as free.
  const [a, b] = [await person(), await person()];
  for (const applicant of [a, b]) {
    await clickText(applicant, 'Try a demo account');
    await applicant.waitForSelector('.rows .row');
    await applicant.goto(teamUrl, { waitUntil: 'domcontentloaded' });
    await applicant.waitForSelector('.team-page');
    await clickText(applicant, 'Ask to join');
  }
  await until(leader, () => document.querySelectorAll('.request-row').length === 2);

  const staleTab = await leader.browserContext().newPage();
  await staleTab.setViewport({ width: 1280, height: 860 });
  // Replace EventSource with a stub before the app loads: this tab never hears live events.
  await staleTab.evaluateOnNewDocument(() => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
  });
  await staleTab.goto(teamUrl, { waitUntil: 'domcontentloaded' });
  await until(staleTab, () => document.querySelectorAll('.request-row').length === 2);

  await leader.bringToFront();
  await clickText(leader, 'Accept'); // the live tab fills the last seat
  await until(leader, () => document.querySelectorAll('.members .member').length === 4);
  assert.equal(await memberCount(staleTab), 3, 'the cut-off tab has not heard about it');

  await staleTab.bringToFront();
  // The other applicant's row: optimistic UI seats them at once, then the server refuses.
  const acceptButtons = await staleTab.$$('.request-row .button-accent');
  await acceptButtons[1].click();
  await staleTab.waitForSelector('.toast-error', { timeout: 5000 });
  const toast = await staleTab.$eval('.toast-error', (el) => el.textContent);
  assert.match(toast, /seat was just taken/i);
  await until(staleTab, () => document.querySelectorAll('.request-row').length === 1);
  assert.equal(await memberCount(staleTab), 4, 'after the rollback the tab shows the real team');
  step('optimistic accept is rolled back when the last seat was taken elsewhere');

  await sleep(200);
  assert.deepEqual(
    consoleErrors.filter((text) => !/stream|409|ERR_FAILED/.test(text)),
    [],
  );
  step('no unexpected console errors');
} finally {
  await browser.close();
}
