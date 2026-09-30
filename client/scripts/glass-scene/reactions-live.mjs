#!/usr/bin/env node
// Live proof of reactions on the stream (WP-G17, docs/glass-spec.md §6.5),
// driven through the app's own controls in the build the instance serves,
// against the Lounge call a `glass-scene.mjs` holder keeps running (Vincent
// sharing, Brendan on camera, Nick muted).
//
//   node scripts/live-env.mjs --port <port> --data <dir>
//   node client/scripts/glass-scene.mjs --base http://127.0.0.1:<port> --out <dir>      # holds the call
//   node client/scripts/glass-scene/reactions-live.mjs --base http://127.0.0.1:<port> --scene <dir>/scene.json
//
// Sean and Luke both watch Vincent's screen without joining. Sean presses the
// flame: his own bubble rises at once, Luke's stage draws it with Sean's face,
// and the server's STREAM_REACTIONS reaches Brendan (in the call) and Luke
// (watching) but not Jeremy (a member of Game Night who is not in Lounge).
// Rapid taps merge within the one-a-second limit, Sean's client never draws
// the echo of his own reaction, and with reduced motion Luke's bubble appears
// in place. The event side is read from realtime streams held with each
// account's own token. Nothing is mocked. PASS/FAIL per step; exits non-zero on
// any FAIL.
//
// Options
//   --base <url>     instance (default http://127.0.0.1:18420)
//   --scene <file>   scene.json a glass-scene run wrote (ids and sign-ins)
//   --out <dir>      where the shots go (default output/design-reference/glass-build/g17/live)
//   --headed         show the browsers

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, holdRealtime } from './api.mjs';
import { dismissOverlays, launchBrowser, openAs, sceneOnScreen } from './ui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = arg('base', 'http://127.0.0.1:18420').replace(/\/+$/, '');
const SCENE = arg('scene', join(repoRoot, 'output', 'design-reference', 'glass-build', 'live', 'scene.json'));
const OUT = resolve(arg('out', join(repoRoot, 'output', 'design-reference', 'glass-build', 'g17', 'live')));
const HEADLESS = !process.argv.includes('--headed');

const scene = JSON.parse(readFileSync(SCENE, 'utf8'));
const gameNight = scene.servers.gameNight;
const lounge = gameNight.channels.lounge;
const general = `/app/guilds/${gameNight.id}/channels/${gameNight.channels.general}`;
const accounts = scene.accounts;
const ids = Object.fromEntries(Object.entries(accounts).map(([name, account]) => [name, String(account.id)]));
const api = createApi(BASE);
const results = [];
const t0 = Date.now();
const log = (line) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}

async function until(fn, timeoutMs = 30_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) return last;
    await sleep(stepMs);
  }
}

const stage = (page) => page.getByRole('region', { name: 'Stage' });
const pill = (page) => page.getByRole('region', { name: /live voice channel|voice call/ });
const visible = (locator) => locator.first().isVisible().catch(() => false);
const bubbles = (page, selector = '') => page.locator(`.glass-stage__stream .glass-reactions__bubble${selector}`);

async function relayHas(token, userId) {
  const room = await api.request(token, 'GET', `/voice/${lounge}/media-stats`);
  return room.participants.some((p) => String(p.user_id) === userId);
}

async function streamShows(page) {
  const box = await page.locator('.glass-stage__stream').first().boundingBox();
  if (!box) return false;
  const { teal, amber } = await sceneOnScreen(page, box);
  return teal > 300 && amber > 1500;
}

/** The stream box's bottom-right corner, where the bubbles rise. */
async function shotCorner(page, name) {
  const box = await page.locator('.glass-stage__stream').first().boundingBox();
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  if (box) {
    const w = Math.min(360, box.width);
    const h = Math.min(420, box.height);
    await page.screenshot({
      path: join(OUT, `${name}-corner.png`),
      clip: { x: box.x + box.width - w, y: box.y + box.height - h, width: w, height: h },
    });
  }
}

/** Every STREAM_REACTIONS an account's own realtime stream delivers. */
function listen(name, token) {
  const seen = [];
  const stream = holdRealtime(api, token, {
    onEvent: (event, data) => {
      if (event === 'STREAM_REACTIONS') seen.push({ at: Date.now(), data });
    },
  });
  return { name, seen, close: () => stream.close() };
}

const fromSean = (listener, since, kind) =>
  listener.seen.filter((e) => e.at >= since).flatMap((e) => e.data.reactions).filter((r) => r.user_id === ids.sean && r.kind === kind);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const jeremyToken = (await api.account(accounts.jeremy, { likelyExists: true })).token;
  if (!(await relayHas(jeremyToken, ids.vincent)) || !(await relayHas(jeremyToken, ids.brendan))) {
    throw new Error('the Lounge call is not held; run glass-scene.mjs first');
  }
  check('Jeremy is a member of Game Night but not in Lounge', !(await relayHas(jeremyToken, ids.jeremy)));

  const brendanToken = (await api.account(accounts.brendan, { likelyExists: true })).token;
  const lukeToken = (await api.account(accounts.luke, { likelyExists: true })).token;
  const listeners = {
    brendan: listen('brendan', brendanToken),
    luke: listen('luke', lukeToken),
    jeremy: listen('jeremy', jeremyToken),
  };
  const browser = await launchBrowser({ headless: HEADLESS });
  try {
    const sean = await openAs(browser, BASE, accounts.sean, { media: { voice: 'quiet' } });
    const luke = await openAs(browser, BASE, accounts.luke, { media: { voice: 'quiet' } });
    for (const who of [sean, luke]) {
      await who.page.goto(general);
      await dismissOverlays(who.page, 700, 6000);
      await pill(who.page).waitFor({ state: 'visible', timeout: 30_000 });
      await pill(who.page).getByRole('button', { name: "Watch Vincent's screen" }).click();
      await until(() => visible(stage(who.page)), 10_000);
    }
    const { page } = sean;
    check("Sean's stream is on screen", await until(() => streamShows(page), 45_000, 1000));
    check("Luke's stream is on screen", await until(() => streamShows(luke.page), 45_000, 1000));
    check('neither joined the call', !(await relayHas(jeremyToken, ids.sean)) && !(await relayHas(jeremyToken, ids.luke)));

    const flame = stage(page).getByRole('button', { name: 'React with fire' });
    check('the flame is enabled once the stream is on screen', await until(async () => (await flame.getAttribute('aria-disabled')) === null, 15_000));

    // 1. Sean, watching, sends a flame.
    const sent = Date.now();
    await flame.click();
    // Watch Sean's own stage for the echo while the rest is checked: an echo
    // that got through would be drawn as someone else's bubble (Sean's face,
    // no data-own) about a quarter second after the press.
    const echo = (async () => {
      let theirs = 0;
      let most = 0;
      while (Date.now() - sent < 2500) {
        theirs = Math.max(theirs, await bubbles(page, ':not([data-own])').count());
        most = Math.max(most, await bubbles(page).count());
        await sleep(50);
      }
      return { theirs, most };
    })();
    const ownDrawn = await until(() => visible(bubbles(page, '[data-own][data-kind="flame"]')), 1000, 50);
    check("Sean's own flame appears at once", ownDrawn, `${Date.now() - sent} ms`);
    await sleep(350);
    await shotCorner(page, 'g17-1-sean-own-flame');

    const lukeDrawn = await until(() => visible(bubbles(luke.page, ':not([data-own])[data-kind="flame"]')), 5000, 50);
    check("Luke's stage draws Sean's flame", lukeDrawn, `${Date.now() - sent} ms after the press`);
    const face = bubbles(luke.page, ':not([data-own])').first().locator('.glass-reactions__face');
    check("…with Sean's face in its corner", await visible(face));
    await sleep(500);
    await shotCorner(luke.page, 'g17-2-luke-sees-sean-flame');

    const brendanGot = await until(() => fromSean(listeners.brendan, sent, 'flame').length > 0, 5000, 100);
    check('Brendan (in the call) receives STREAM_REACTIONS', brendanGot);
    const lukeGot = await until(() => fromSean(listeners.luke, sent, 'flame').length > 0, 5000, 100);
    check('Luke (watching) receives STREAM_REACTIONS', lukeGot);
    await sleep(2000);
    check('Jeremy (in Game Night, not in Lounge) does not', listeners.jeremy.seen.length === 0, `${listeners.jeremy.seen.length} events`);
    const event = listeners.brendan.seen.at(-1)?.data;
    check('the event names the channel, the stream and the sender', event?.channel_id === lounge
      && event.reactions.some((r) => r.stream_user_id === ids.vincent && r.user_id === ids.sean && typeof r.nonce === 'string'));

    // 2. The echo is dropped: Sean never draws a second flame for one press.
    const seen = await echo;
    check("Sean's client drops the echo of his own flame (2.5 s after the press)",
      seen.theirs === 0 && seen.most === 1, `${seen.most} bubble(s) at most, ${seen.theirs} not his own`);
    await until(async () => (await bubbles(page).count()) === 0 && (await bubbles(luke.page).count()) === 0, 5000);

    // 3. Four quick hearts: all drawn for Sean, merged within the limit for everyone else.
    const heart = stage(page).getByRole('button', { name: 'React with a heart' });
    const burst = Date.now();
    for (let i = 0; i < 4; i += 1) await heart.click();
    check('four taps draw four hearts for Sean', await until(async () => (await bubbles(page, '[data-own][data-kind="heart"]').count()) === 4, 1500, 50));
    const merged = await until(() => {
      const hearts = fromSean(listeners.brendan, burst, 'heart');
      const total = hearts.reduce((sum, r) => sum + r.count, 0);
      return total === 4 ? hearts : null;
    }, 6000, 100);
    check('the four taps reach the call as at most two requests (one a second, merged)',
      Boolean(merged) && merged.length <= 2, merged ? merged.map((r) => r.count).join(' + ') : 'not all arrived');
    await sleep(300);
    await shotCorner(luke.page, 'g17-3-luke-sees-merged-hearts');
    const countBadge = await until(async () => {
      const text = await luke.page.locator('.glass-stage__stream .glass-reactions__count').first().textContent().catch(() => null);
      return text ? text : null;
    }, 2500, 50);
    check("Luke's stage shows the merged hearts with their count", Boolean(countBadge), countBadge ? `badge ${countBadge}` : 'no badge');
    const toasts = await page.getByText(/Your reaction was not sent/).count();
    check('no reaction failed to send', toasts === 0);
    await until(async () => (await bubbles(luke.page).count()) === 0, 5000);

    // 4. Reduced motion: the bubble appears in place and goes.
    await luke.page.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(1100); // the limit
    const still = Date.now();
    await flame.click();
    const stillDrawn = await until(() => visible(bubbles(luke.page, '[data-still]')), 5000, 50);
    check("with reduced motion, Luke's bubble appears in place", stillDrawn, `${Date.now() - still} ms`);
    await sleep(200);
    await shotCorner(luke.page, 'g17-4-luke-reduced-motion');
    check('…and goes again', await until(async () => (await bubbles(luke.page).count()) === 0, 4000, 100));

    for (const who of [sean, luke]) {
      await stage(who.page).getByRole('button', { name: /Stop watching/ }).click().catch(() => {});
    }
    const errors = [...sean.logs, ...luke.logs].filter((line) => line.startsWith('pageerror'));
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    for (const listener of Object.values(listeners)) listener.close();
  }
  writeFileSync(join(OUT, 'reactions-live.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length} of ${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
