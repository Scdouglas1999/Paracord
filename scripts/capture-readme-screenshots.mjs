#!/usr/bin/env node
/**
 * Capture the README screenshots from a running Paracord instance.
 *
 * Expects an instance seeded by `scripts/seed-demo-community.py` — pointed at a
 * fresh instance this only ever produces empty states, which do not represent
 * the product.
 *
 * Everyone visible in the resulting images holds a real session for the whole
 * run: the crowd through the browser, and the people shown inside voice rooms
 * through the same realtime handshake the client performs (session → ticket →
 * stream). Nothing is written directly into the database.
 *
 * Usage:
 *   python3 scripts/seed-demo-community.py
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
 *     node scripts/capture-readme-screenshots.mjs
 *
 * Env:
 *   PARACORD_BASE        instance URL (default https://127.0.0.1:8443)
 *   PARACORD_DEMO_OUT    seed manifest written by the seeder (default demo-seed.json)
 *   PARACORD_SHOTS_OUT   output directory (default docs/images/readme)
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` is needed only because a first-run instance
 * serves a self-signed certificate.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'client', 'package.json'));
const { chromium } = require('playwright');

const BASE = (process.env.PARACORD_BASE || 'https://127.0.0.1:8443').replace(/\/$/, '');
const SEED_PATH = path.resolve(ROOT, process.env.PARACORD_DEMO_OUT || 'demo-seed.json');
const OUT = path.resolve(ROOT, process.env.PARACORD_SHOTS_OUT || 'docs/images/readme');
const VIEWPORT = { width: 1440, height: 900 };
/** Shot at 2x, then downscaled to this width so the repo stays light. */
const OUTPUT_WIDTH = 1760;

const seed = JSON.parse(await readFile(SEED_PATH, 'utf8'));
const G = seed.guild_id;
const log = (...a) => console.log('·', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });

/** Realtime streams held open for people who have no browser of their own. */
const heldStreams = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--ignore-certificate-errors'],
});

async function newContext(scale = 1) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: scale,
    ignoreHTTPSErrors: true,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('paracord:v2:layout-tour-shell', 'done');
      localStorage.setItem('paracord:v2:layout-tour-guild-home', 'done');
    } catch { /* storage unavailable */ }
  });
  return ctx;
}

/** Dismiss the space welcome modal and any first-run coach mark. */
async function clearOverlays(page) {
  for (let i = 0; i < 8; i += 1) {
    const jump = page.getByRole('button', { name: /^jump in$/i }).first();
    if (await jump.isVisible().catch(() => false)) {
      await jump.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }
    const tour = page.getByRole('button', { name: /^(skip tour|done)$/i }).first();
    if (await tour.isVisible().catch(() => false)) {
      await tour.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    break;
  }
}

async function signIn(email, scale = 1) {
  const ctx = await newContext(scale);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input.input-field', { timeout: 25_000 });
  await page.locator('input.input-field').nth(0).fill(email);
  await page.locator('input.input-field').nth(1).fill(seed.password);
  await page.getByRole('button', { name: /^log in$/i }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await clearOverlays(page);
  return { ctx, page };
}

/**
 * Put someone in a voice room, holding a realtime session open for them.
 *
 * These people deliberately have no browser client: one that finds itself in a
 * room it never joined reconciles its way back out, which empties the grid. The
 * held stream is what marks them present, so they read as online rather than as
 * a body in an empty room.
 */
async function placeInRoom(who, channelId) {
  const jsonHeaders = { 'content-type': 'application/json' };
  const lr = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email: `${who}@commons.test`, password: seed.password }),
  });
  if (!lr.ok) return false;
  const { token } = await lr.json();
  const auth = { authorization: `Bearer ${token}` };

  const sr = await fetch(`${BASE}/api/v2/rt/session`, {
    method: 'POST', headers: { ...auth, ...jsonHeaders }, body: '{}',
  });
  if (!sr.ok) return false;
  const session = await sr.json();

  const tr = await fetch(`${BASE}/api/v1/stream/ticket`, { method: 'POST', headers: auth });
  if (!tr.ok) return false;
  const { ticket } = await tr.json();

  const ac = new AbortController();
  const stream = await fetch(
    `${BASE}/api/v2/rt/events?ticket=${ticket}&session_id=${encodeURIComponent(session.session_id)}`,
    { headers: auth, signal: ac.signal },
  );
  if (!stream.ok) return false;
  // Drain in the background; holding the connection is the point, not the data.
  (async () => {
    try {
      const reader = stream.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    } catch { /* aborted at teardown */ }
  })();
  heldStreams.push(ac);

  const jr = await fetch(`${BASE}/api/v1/voice/${channelId}/join`, { headers: auth });
  return jr.ok;
}

const IDLE_CROWD = ['jonas', 'ken', 'lena', 'diego'];
const ROOM_PLAN = [
  ['priya', seed.studio, 'Studio'], ['tomas', seed.studio, 'Studio'],
  ['yara', seed.studio, 'Studio'],
  ['ade', seed.focus, 'Focus Room'], ['sofia', seed.focus, 'Focus Room'],
];

// The account we shoot from connects first, so it receives every presence and
// voice-state event live as the others arrive.
const { page } = await signIn(seed.owner_email, 2);
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
await page.goto(`${BASE}/app/guilds/${G}`, { waitUntil: 'domcontentloaded' });
await sleep(2000);
await clearOverlays(page);
log('signed in as owner');

const held = [];
for (const who of IDLE_CROWD) {
  try {
    const s = await signIn(`${who}@commons.test`);
    await s.page.goto(`${BASE}/app/guilds/${G}`, { waitUntil: 'domcontentloaded' });
    await s.page.waitForTimeout(1200);
    await clearOverlays(s.page);
    held.push(s);
    log('online:', who);
  } catch (e) { console.error('  !!', who, e.message); }
}
for (const [who, roomId, roomName] of ROOM_PLAN) {
  const ok = await placeInRoom(who, roomId);
  log(`${ok ? 'in room' : '!! FAILED'}: ${who} → ${roomName}`);
}

// Keep every held session active so nothing idles out mid-run.
const keepAlive = setInterval(() => {
  for (const s of held) s.page.evaluate(() => void document.hasFocus()).catch(() => {});
}, 5000);

// A room's duration counts from the moment THIS PAGE first saw it lit — the
// gateway sends membership, not call start times, and the client refuses to
// invent one (`lib/attention/litHistory.ts`). So the lobby is opened FIRST and
// the rooms are left to run while it watches; a reload here would restart every
// clock at zero and the cards would read "0:03".
await page.goto(`${BASE}/app/guilds/${G}`, { waitUntil: 'domcontentloaded' });
await sleep(3000);
await clearOverlays(page);
const DWELL_MS = Number(process.env.PARACORD_SHOTS_DWELL_MS ?? 95_000);
log(`watching the rooms for ${Math.round(DWELL_MS / 1000)}s so the durations are real`);
await sleep(DWELL_MS);

// The Lobby says what it sees in the light vocabulary
// (docs/lantern-stage-spec.md §7.3), and a capture with nothing lit is a
// capture of the wrong product — so the run says so out loud.
const seen = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    lit: (t.match(/(\d+)\s+rooms?\s+lit/i) || [])[1],
    on: (t.match(/(\d+)(?:\s+of\s+\d+)?\s+have their lights on/i) || [])[1],
  };
});
log(`the building shows: ${seen.lit ?? 0} rooms lit, ${seen.on ?? 0} with their lights on`);
if (!seen.lit || seen.lit === '0') {
  console.error('  !! nothing is lit — the screenshots would show a dark building');
}

const captured = [];
async function shot(name, ms = 900) {
  // Park the pointer somewhere inert so a stray hover tooltip stays out of frame.
  await page.mouse.move(VIEWPORT.width - 4, VIEWPORT.height - 4);
  await sleep(ms);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });
  captured.push(name);
  log('captured', name);
}

await shot('lobby', 1200);

await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
await sleep(2500);
await clearOverlays(page);
await shot('home', 1200);

await page.goto(`${BASE}/app/guilds/${G}/channels/${seed.general}`, { waitUntil: 'domcontentloaded' });
await sleep(2500);
await clearOverlays(page);
await shot('messaging', 1200);

// There is no docked member list (§6.5). The people who are here now are the
// header's lit strip, and its sheet is the only full list in the product. Scope
// to the room header: the account plate in the column also says "Lights on".
const strip = page.locator('.chat-header').getByRole('button', { name: /reading/i }).first();
if (await strip.isVisible().catch(() => false)) {
  await strip.click();
  await sleep(1600);
  await shot('people', 900);
  await page.keyboard.press('Escape');
  await sleep(600);
} else console.error('  !! the here-now strip was not on the header');

await page.goto(`${BASE}/app/guilds/${G}/channels/${seed.engineering}`, { waitUntil: 'domcontentloaded' });
await sleep(2500);
await clearOverlays(page);
await shot('engineering', 1000);

// Left unfiltered on purpose: the default list shows what the palette can
// reach — actions, navigation, channels, spaces.
await page.keyboard.press('Control+k');
await sleep(1200);
await shot('command-palette', 600);
await page.keyboard.press('Escape');
await sleep(500);

await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
await sleep(1800);
await clearOverlays(page);
await page.keyboard.press('Control+,');
await sleep(1800);
const appearance = page.getByRole('button', { name: /^appearance$/i }).first();
if (await appearance.isVisible().catch(() => false)) {
  await appearance.click();
  await sleep(1200);
}
await shot('appearance', 900);
await page.keyboard.press('Escape');
await sleep(600);

await page.goto(`${BASE}/app/guilds/${G}`, { waitUntil: 'domcontentloaded' });
await sleep(2200);
await clearOverlays(page);
await page.keyboard.press('Control+Shift+,');
await sleep(2200);
await shot('space-settings', 900);

clearInterval(keepAlive);
for (const ac of heldStreams) ac.abort();
await browser.close();

await writeFile(
  path.join(OUT, 'manifest.json'),
  `${JSON.stringify({
    captured_at: new Date().toISOString().slice(0, 10),
    folder: path.relative(ROOT, OUT).split(path.sep).join('/'),
    viewport: { ...VIEWPORT, device_scale_factor: 2 },
    output_width: OUTPUT_WIDTH,
    theme: 'night',
    accent: 'emerald',
    design: 'lantern-stage',
    files: captured.map((n) => `${n}.jpg`),
  }, null, 2)}\n`,
);

console.log(`\ncaptured ${captured.length} screenshots -> ${OUT}`);
console.log(
  `PNGs are 2x. Downscale to ${OUTPUT_WIDTH}px wide and save as JPEG (quality ~86) ` +
  'before committing, so the repo does not carry multi-megabyte images.',
);
