#!/usr/bin/env node
// Live proof of the Glass stage (WP-G14), driven only through the app's own
// controls in the build the instance serves, against the Lounge call a
// `glass-scene.mjs` holder keeps running (Vincent sharing, Brendan on camera
// and talking, Nick muted).
//
//   node scripts/live-env.mjs --port <port> --data <dir>
//   node client/scripts/glass-scene.mjs --base http://127.0.0.1:<port> --out <dir>      # holds the call
//   node client/scripts/glass-scene/stage-live.mjs --base http://127.0.0.1:<port> --scene <dir>/scene.json
//
// Sean watches from the call pill without joining, Luke (another account) opens
// the same stream and both see the watcher count, Sean joins and leaves from the
// stage, and Stop watching keeps the call. Every claim is read from the page
// (text, and the pixels of the stream and of Brendan's tile) or from the
// server's own counters (`/voice/{id}/media-stats`, `/api/v2/voice/{id}/watchers`).
// Nothing is mocked. PASS/FAIL per step; exits non-zero on any FAIL.
//
// Options
//   --base <url>     instance (default http://127.0.0.1:18420)
//   --scene <file>   scene.json a glass-scene run wrote (ids and sign-ins)
//   --out <dir>      where the shots go (default output/design-reference/glass-build/g14/live)
//   --headed         show the browsers

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { dismissOverlays, launchBrowser, openAs, pictureIn, sceneOnScreen } from './ui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = arg('base', 'http://127.0.0.1:18420').replace(/\/+$/, '');
const SCENE = arg('scene', join(repoRoot, 'output', 'design-reference', 'glass-build', 'live', 'scene.json'));
const OUT = resolve(arg('out', join(repoRoot, 'output', 'design-reference', 'glass-build', 'g14', 'live')));
const HEADLESS = !process.argv.includes('--headed');

const scene = JSON.parse(readFileSync(SCENE, 'utf8'));
const gameNight = scene.servers.gameNight;
const lounge = gameNight.channels.lounge;
const general = `/app/guilds/${gameNight.id}/channels/${gameNight.channels.general}`;
const accounts = scene.accounts;
const ids = { sean: accounts.sean.id, vincent: accounts.vincent.id, brendan: accounts.brendan.id };
const api = createApi(BASE);
const results = [];
const t0 = Date.now();
const log = (line) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}

async function until(fn, timeoutMs = 30_000, stepMs = 500) {
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

/** Vincent's scene inside the stage's stream: its teal and amber pixels. */
async function streamScene(page) {
  const box = await page.locator('.glass-stage__stream').first().boundingBox();
  if (!box) return { teal: 0, amber: 0 };
  const { teal, amber } = await sceneOnScreen(page, box);
  return { teal, amber };
}
const sceneShows = (seen) => seen.teal > 300 && seen.amber > 1500;

async function watcherCount(token) {
  const counts = await api.request(token, 'GET', `/api/v2/voice/${lounge}/watchers`);
  return counts.streams.find((s) => s.user_id === ids.vincent)?.watchers ?? 0;
}
async function relayHas(token, userId) {
  const room = await api.request(token, 'GET', `/voice/${lounge}/media-stats`);
  return room.participants.some((p) => String(p.user_id) === userId);
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const jeremy = (await api.account(accounts.jeremy, { likelyExists: true })).token;
  if (!(await relayHas(jeremy, ids.vincent)) || !(await relayHas(jeremy, ids.brendan))) {
    throw new Error('the Lounge call is not held; run glass-scene.mjs first');
  }
  const browser = await launchBrowser({ headless: HEADLESS });
  try {
    const sean = await openAs(browser, BASE, accounts.sean, { media: { voice: 'quiet' } });
    const luke = await openAs(browser, BASE, accounts.luke, { media: { voice: 'quiet' } });
    for (const who of [sean, luke]) {
      await who.page.goto(general);
      await dismissOverlays(who.page, 700, 6000);
      await pill(who.page).waitFor({ state: 'visible', timeout: 30_000 });
    }
    const { page } = sean;

    // 1. Watch from the pill, without joining.
    await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
    check('Watch on the pill opens the stage', await until(() => visible(stage(page)), 10_000));
    check('the pill is not drawn beside the stage', await until(async () => !(await visible(pill(page))), 5_000));
    const seen = await until(async () => {
      const s = await streamScene(page);
      return sceneShows(s) ? s : null;
    }, 45_000, 1000);
    check("Vincent's frames render in the stream", Boolean(seen), seen ? `${seen.teal}px teal, ${seen.amber}px amber` : 'nothing on screen');
    check('watching did not join the call', !(await relayHas(jeremy, ids.sean)) && await visible(stage(page).getByRole('button', { name: 'Join Lounge' })));
    check("the overlay names the stream and the place", await visible(stage(page).getByText("Vincent's screen")) && await visible(stage(page).getByText(/Game Night Lounge/)));
    const brendanTile = page.locator('.glass-stage__tile', { hasText: 'Brendan' });
    check('Brendan has a camera tile', await until(() => visible(brendanTile), 5_000));
    check('the server counts the watch', await until(async () => (await watcherCount(jeremy)) === 1, 10_000), `${await watcherCount(jeremy)} watching`);
    check('Sean sees "1 watching"', await until(() => visible(stage(page).getByText('1 watching')), 10_000));
    await shot(page, 'stage-live-1-watching-not-joined');

    // 2. Another account watches too: both see the count move.
    await pill(luke.page).getByRole('button', { name: "Watch Vincent's screen" }).click();
    check('Luke sees "2 watching" on his stage', await until(() => visible(stage(luke.page).getByText('2 watching')), 20_000));
    check('Sean sees "2 watching" (the count reaches others live)', await until(() => visible(stage(page).getByText('2 watching')), 20_000));
    await stage(luke.page).getByRole('button', { name: /Stop watching/ }).click();
    check("Luke's Stop watching brings Sean back to \"1 watching\"", await until(() => visible(stage(page).getByText('1 watching')), 20_000));

    // 3. Join from the stage.
    await stage(page).getByRole('button', { name: 'Join Lounge' }).click();
    check('Join on the stage joins the call', await until(() => relayHas(jeremy, ids.sean), 30_000));
    check('the stage shows the joined controls (Leave, no Join)', await until(async () =>
      (await visible(stage(page).getByRole('button', { name: 'Leave Lounge' })))
      && !(await visible(stage(page).getByRole('button', { name: 'Join Lounge' }))), 15_000));
    const camera = await until(async () => {
      const tile = brendanTile.first();
      if (!(await tile.isVisible().catch(() => false))) return null;
      const picture = await pictureIn(page, tile.locator('canvas'));
      return picture.distinctColors > 40 ? picture : null;
    }, 30_000, 1000);
    check("Brendan's camera draws in his tile once joined", Boolean(camera), camera ? `${camera.distinctColors} colors` : 'no picture');
    const joinedScene = await until(async () => {
      const s = await streamScene(page);
      return sceneShows(s) ? s : null;
    }, 30_000, 1000);
    check("the stream keeps playing through the join (the watch rides the call)", Boolean(joinedScene));
    check('the watch is still counted once', await until(async () => (await watcherCount(jeremy)) === 1, 10_000));
    // The move onto the call settles after the join commits; hold on and look again.
    await sleep(6000);
    const settled = await streamScene(page);
    check('…and is still on screen 6s after the join', sceneShows(settled), `${settled.teal}px teal, ${settled.amber}px amber`);
    check('…and still counted once', (await watcherCount(jeremy)) === 1);
    await shot(page, 'stage-live-2-joined');

    // 4. Stop watching keeps the call.
    await stage(page).getByRole('button', { name: /Stop watching/ }).click();
    check('Stop watching closes the stage', await until(async () => !(await visible(stage(page))), 10_000));
    check('…and keeps the call', await relayHas(jeremy, ids.sean) && await until(() => visible(pill(page).getByRole('button', { name: 'Leave Lounge' })), 10_000));
    check('…and stops the watch', await until(async () => (await watcherCount(jeremy)) === 0, 10_000));

    // 5. Watch again inside the call, then Leave from the stage: the watch stays.
    await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
    await until(() => visible(stage(page)), 10_000);
    await stage(page).getByRole('button', { name: 'Leave Lounge' }).click();
    check('Leave on the stage leaves the call', await until(async () => !(await relayHas(jeremy, ids.sean)), 20_000));
    check('…and the stage stays open', await visible(stage(page)));
    const afterLeave = await until(async () => {
      const s = await streamScene(page);
      return sceneShows(s) ? s : null;
    }, 45_000, 1000);
    check('…still watching after leaving (the watch moved back to its own session)', Boolean(afterLeave));
    await sleep(6000);
    const later = await streamScene(page);
    check('…and still on screen 6s later', sceneShows(later), `${later.teal}px teal, ${later.amber}px amber`);
    check('…and counted once', await until(async () => (await watcherCount(jeremy)) === 1, 10_000));
    await shot(page, 'stage-live-3-left-still-watching');

    // 6. Esc stops watching.
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Escape');
    check('Esc stops watching', await until(async () => !(await visible(stage(page))), 10_000));

    const errors = [...sean.logs, ...luke.logs].filter((line) => line.startsWith('pageerror'));
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
  writeFileSync(join(OUT, 'stage-live.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length} of ${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
