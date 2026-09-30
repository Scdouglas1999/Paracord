// Driving the app itself in Chromium: signing a cast member in, clearing the
// first-run panels, and pressing the call controls.
//
// Controls are found by their accessible names. Each action lists every name
// it answers to, current (Lantern) first; when a Glass package renames a
// control, add the new name here rather than reaching for CSS selectors.

import { chromium } from '@playwright/test';
import { mediaInitScript } from './media-init.mjs';

export const MEDIA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  // A held call runs for hours in pages nobody looks at; keep their timers,
  // encoders and canvases running at full rate.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

export const CONTROLS = {
  join: ['Join voice', 'Join', 'Join Lounge'],
  leave: ['Disconnect from voice', 'Leave', 'Leave Lounge'],
  share: ['Share screen', 'Share your screen'],
  stopShare: ['Stop streaming', 'Stop sharing'],
  cameraOn: ['Turn on camera'],
  cameraOff: ['Turn off camera'],
  mute: ['Mute microphone', 'Mute'],
  unmute: ['Unmute microphone', 'Unmute'],
  // The lobby's per-person Watch joins and opens that share in one go.
  watch: [/^Watch \w+'s screen$/i, 'Watch'],
  retryJoin: ['Try joining again'],
  // The Glass stage (WP-G14).
  stopWatching: ['Stop watching'],
  browse: ['Show servers and channels'],
};

const OVERLAYS = ['Close welcome screen', 'Skip tour', 'Got it', 'Maybe later', 'Dismiss'];

export function launchBrowser({ headless = true } = {}) {
  return chromium.launch({ headless, args: MEDIA_ARGS });
}

/**
 * A signed-in page for one cast member, through the login page like a person
 * (the app keeps its own session state beside the cookies, so a cookie from a
 * side-channel login does not get past the login page).
 */
export async function openAs(browser, base, person, { viewport = { width: 1440, height: 900 }, media = null, log = () => {} } = {}) {
  const context = await browser.newContext({ baseURL: base, viewport, deviceScaleFactor: 1 });
  await context.grantPermissions(['microphone', 'camera'], { origin: base });
  if (media) await context.addInitScript({ content: mediaInitScript(media) });
  const logs = [];
  const page = await context.newPage();
  page.on('pageerror', error => logs.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') logs.push(`console: ${message.text()}`);
  });
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').first().fill(person.email, { timeout: 45_000 });
  await page.locator('input[type="password"]').first().fill(person.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 45_000 });
  await dismissOverlays(page);
  log(`  ${person.name} is in the app`);
  return { person, context, page, logs };
}

/** The shell tour and welcome screens arrive in either order on a fresh account. */
export async function dismissOverlays(page, quietMs = 1200, deadlineMs = 12_000) {
  const deadline = Date.now() + deadlineMs;
  let lastSeen = Date.now();
  while (Date.now() < deadline && Date.now() - lastSeen < quietMs) {
    for (const name of OVERLAYS) {
      const control = page.getByRole('button', { name, exact: true });
      if (await control.first().isVisible().catch(() => false)) {
        await control.first().click({ timeout: 2000 }).catch(() => {});
        lastSeen = Date.now();
      }
    }
    await page.waitForTimeout(200);
  }
}

/** The first visible button answering to any of `names`, or null. */
export async function findControl(page, names) {
  for (const name of names) {
    const control = page.getByRole('button', name instanceof RegExp ? { name } : { name, exact: true }).first();
    if (await control.isVisible().catch(() => false)) return control;
  }
  return null;
}

export async function waitForControl(page, names, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const control = await findControl(page, names);
    if (control) return control;
    if (Date.now() > deadline) throw new Error(`no control named ${names.map(String).join(' / ')} appeared within ${timeoutMs / 1000}s`);
    await page.waitForTimeout(300);
  }
}

/** Click a control, re-clearing overlays that can land between render and click. */
export async function press(page, names, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    await dismissOverlays(page, 300, 2000);
    const control = await findControl(page, names);
    if (control) {
      try { await control.click({ timeout: 3000 }); return; } catch (error) { lastError = error; }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`could not press ${names.map(String).join(' / ')}${lastError ? `: ${lastError.message.split('\n')[0]}` : ''}`);
}

export function channelPath(ids, serverKey, channelKey) {
  const server = ids.servers[serverKey];
  if (!server) throw new Error(`scene has no server ${serverKey}`);
  const channelId = server.channels[channelKey];
  if (!channelId) throw new Error(`${server.name} has no channel ${channelKey}`);
  return `/app/guilds/${server.id}/channels/${channelId}`;
}

/**
 * Wait until the call is connected. A join the app refuses (its "Try joining
 * again" appears) is a failure, reported with the reason the app gave: the
 * driver does not retry. Rejoining a running call used to be refused
 * (docs/design/glass-fix-rejoin.md), and this used to paper over it with
 * retries and a 15s pause; that fix landed, so a refusal now is a finding.
 */
export async function awaitJoined(session, { timeoutMs = 60_000, log = () => {} } = {}) {
  const { page, person } = session;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await findControl(page, CONTROLS.leave)) return;
    if (await findControl(page, CONTROLS.retryJoin)) break;
    await page.waitForTimeout(400);
  }
  const reason = (await page.locator('text=/could not|couldn.t|failed/i').allTextContents().catch(() => []))
    .map(t => t.trim()).filter(Boolean).slice(0, 3).join(' / ') || `no connected call within ${timeoutMs / 1000}s`;
  log(`  ${person.name}: join failed: ${reason}`);
  throw new Error(`${person.name} could not join the call: ${reason}`);
}

/** Join a voice channel through the UI and wait for the call to connect. */
export async function joinVoice(session, path, { log = () => {} } = {}) {
  const { page } = session;
  await page.goto(path);
  await dismissOverlays(page, 800, 8000);
  await press(page, CONTROLS.join, { timeoutMs: 45_000 });
  return awaitJoined(session, { log });
}

/**
 * Whether an element shows a picture rather than an empty well: screenshot it
 * and count its colors in the page (the app's CSP refuses a data: fetch, so the
 * PNG goes in through a Blob). A canvas nobody painted is one or two colors.
 */
export async function pictureIn(page, locator) {
  const png = (await locator.screenshot()).toString('base64');
  return page.evaluate(async base64 => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const colors = new Set();
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 24) lit += 1;
      colors.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
    }
    return { distinctColors: colors.size, litFraction: lit / (data.length / 4) };
  }, png);
}

/**
 * Wait for the page to produce two fresh animation frames, so a screenshot is
 * of the page as it is now. A busy renderer (several live decoders) can lag
 * the compositor by seconds, and a screenshot taken then is of the past.
 */
export async function freshFrame(page, timeoutMs = 20_000) {
  const started = Date.now();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    .catch(() => {});
  const waited = Date.now() - started;
  if (waited > timeoutMs) throw new Error(`the page took ${waited}ms to paint a frame`);
  return waited;
}

/**
 * How much of Vincent's scene is on screen right now: pixels of its teal
 * crystal light and its amber glow, counted in a fresh screenshot of the page
 * (inside `clip` when given). This is what "Sean can see the share" means —
 * DOM state alone has been wrong about it.
 */
export async function sceneOnScreen(page, clip = undefined) {
  await freshFrame(page);
  const shot = await page.screenshot(clip ? { clip } : {});
  const png = shot.toString('base64');
  const counts = await page.evaluate(async base64 => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let teal = 0;
    let amber = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (g > 150 && b > 130 && r < g - 50 && Math.abs(g - b) < 70) teal += 1;
      if (r > 170 && g > 90 && g < r - 25 && b < g - 25) amber += 1;
    }
    return { teal, amber };
  }, png);
  return { ...counts, png: shot };
}
