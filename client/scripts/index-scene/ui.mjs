// Driving the app itself: the Index build, through the docs/design/index-plan.md
// 1.3 test ids (`ix-card-join`, `ix-room-row`, `ix-card-open-call`,
// `ix-card-leave`, ...) and the accessible names the spec gives its controls. A
// control that is missing is reported by name, never worked around.
//
// Moving between places never reloads the page: a reload would drop the call
// the viewer is in and lock their encryption again. The router is told the URL
// changed instead, which is what clicking a link does.

import { chromium } from '@playwright/test';

import { mediaInitScript } from '../scene-lib/media-init.mjs';
import { MEDIA_ARGS, dismissOverlays, findControl, press, waitForControl } from '../scene-lib/ui.mjs';

export { dismissOverlays, findControl, press, waitForControl };

/**
 * Sign a person in through the login page in a *persistent* Chromium profile.
 *
 * Direct messages are end-to-end encrypted with an identity that lives in the
 * browser (IndexedDB, with a device key the browser will not export), not on
 * the server. A fresh browser is a new device and cannot read the person's DMs,
 * and the identity cannot be copied between browsers (storage state drops the
 * key). So the viewer, who reads and writes DMs, is the same device every time:
 * one profile directory, used by the first seed and by every run after it.
 * Cookies are cleared on the way in, so the person signs in through the page.
 *
 * One process at a time may use a profile (Chromium locks it).
 */
export async function openPersistentSession(base, person, { profileDir, headless = true, viewport, media = null, log = () => {} }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless, args: MEDIA_ARGS, baseURL: base, viewport, deviceScaleFactor: 1,
  });
  await context.clearCookies();
  await context.grantPermissions(['microphone', 'camera'], { origin: base });
  if (media) await context.addInitScript({ content: mediaInitScript(media) });
  const logs = [];
  const page = context.pages()[0] ?? await context.newPage();
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
  log(`  ${person.name} is in the app (profile ${profileDir})`);
  return { person, context, page, logs };
}

/** The test ids the Index build is specified to carry (index-plan 1.3). */
export const IX = {
  sidebar: '[data-testid="ix-sidebar"]',
  card: '[data-testid="ix-room-card"]',
  cardJoin: '[data-testid="ix-card-join"]',
  cardOpenCall: '[data-testid="ix-card-open-call"]',
  cardLeave: '[data-testid="ix-card-leave"]',
  roomRow: '[data-testid="ix-room-row"]',
  dockItem: '[data-testid="ix-dock-item"]',
  channelRow: '[data-testid="ix-channel-row"]',
  welcome: '[data-testid="ix-welcome"]',
  actionCard: '[data-testid="ix-action-card"]',
  composer: '[data-testid="ix-composer"]',
  title: '[data-testid="ix-title"]',
  call: '[data-testid="ix-call"]',
  callBack: '[data-testid="ix-call-back"]',
  callLeave: '[data-testid="ix-call-leave"]',
};

/** Names the card's screen control answers to. */
const SHARE = ['Share your screen'];
const STOP_SHARE = ['Stop sharing your screen'];

/** Go to an app path without reloading the page (see the header). */
export async function navigate(page, path, { settleMs = 600 } = {}) {
  await page.evaluate(to => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  const want = path.split('?')[0];
  await page.waitForFunction(p => window.location.pathname === p, want, { timeout: 15_000 });
  await dismissOverlays(page, 400, 3000);
  await page.waitForTimeout(settleMs);
}

export function guildPath(ids, serverKey, channelKey) {
  const server = ids.servers[serverKey];
  if (!server) throw new Error(`scene has no server ${serverKey}`);
  const channelId = server.channels[channelKey];
  if (!channelId) throw new Error(`${server.name} has no channel ${channelKey}`);
  return `/app/guilds/${server.id}/channels/${channelId}`;
}

/** The first of several candidate controls to be on screen, polling. */
async function firstVisible(page, probes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const [name, find] of Object.entries(probes)) {
      const locator = await find();
      if (locator && await locator.isVisible().catch(() => false)) return { name, locator };
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(250);
  }
}

/** True once this page is connected to a call (the card offers Leave). */
export async function isJoined(page) {
  return (await page.locator(IX.cardLeave).count()) > 0;
}

/**
 * Join a room through the app's own controls and wait until the call is
 * connected: from the room card when it is the busiest room, else from its row
 * under Voice channels. `textPath` is a text channel of the room's server;
 * `roomName` is what the UI calls the room.
 */
export async function joinRoom(session, { textPath, roomName, log = () => {} }) {
  const { page } = session;
  if (await isJoined(page)) throw new Error(`${session.person.name} is already in a call; leave it before joining ${roomName}`);
  const probes = {
    'ix-card-join': () => page.locator(IX.card).filter({ hasText: roomName }).locator(IX.cardJoin).first(),
    'ix-room-row': () => page.locator(IX.roomRow).filter({ hasText: roomName }).first(),
  };
  await navigate(page, textPath);
  const found = await firstVisible(page, probes, 45_000);
  if (!found) {
    throw new Error(`no way to join "${roomName}" appeared: neither ix-room-card/ix-card-join nor ix-room-row`);
  }
  await found.locator.click({ timeout: 5000 });
  const until = Date.now() + 60_000;
  while (!(await isJoined(page))) {
    if (Date.now() > until) {
      const reason = (await page.locator('text=/could not|couldn.t|failed/i').allTextContents().catch(() => []))
        .map(t => t.trim()).filter(Boolean).slice(0, 3).join(' / ') || 'no Leave control appeared';
      throw new Error(`${session.person.name} could not join ${roomName} (via ${found.name}): ${reason}`);
    }
    await page.waitForTimeout(400);
  }
  log(`    (joined via ${found.name})`);
}

/** Leave whatever call this page is in, and wait until Leave is gone. */
export async function leaveRoom(session) {
  const { page } = session;
  await page.locator(IX.cardLeave).first().click({ timeout: 5000 });
  const deadline = Date.now() + 20_000;
  while (await isJoined(page)) {
    if (Date.now() > deadline) throw new Error(`${session.person.name} is still in the call 20s after pressing Leave`);
    await page.waitForTimeout(300);
  }
}

/**
 * Switch the microphone on or off with the room card's mic, which is named for
 * what it does ("Mute" / "Unmute") and carries its state in `data-muted`.
 */
export async function setMic(session, on) {
  const cardMic = session.page.locator('[data-testid="ix-card-mic"]').first();
  if (!(await cardMic.isVisible().catch(() => false))) {
    throw new Error(`${session.person.name} has no room card microphone (ix-card-mic) on screen`);
  }
  // A fresh join can still apply the join-muted preference after the card has
  // drawn, so the state has to hold for two seconds, not just appear once.
  const want = on ? 'false' : 'true';
  const deadline = Date.now() + 20_000;
  let steadySince = null;
  let pressedAt = 0;
  for (;;) {
    const state = await cardMic.getAttribute('data-muted').catch(() => null);
    if (state === want) {
      steadySince ??= Date.now();
      if (Date.now() - steadySince >= 2000) return;
    } else {
      steadySince = null;
      if (Date.now() - pressedAt > 3000) {
        await cardMic.click({ timeout: 5000 });
        pressedAt = Date.now();
      }
    }
    if (Date.now() > deadline) throw new Error(`the card's microphone did not stay ${on ? 'on' : 'off'} within 20s`);
    await session.page.waitForTimeout(250);
  }
}

/** Start sharing the (canvas) screen with the card's screen control. */
export async function startShare(session) {
  const { page } = session;
  await press(page, SHARE);
  await waitForControl(page, STOP_SHARE, 30_000);
}

/** Open the call over the conversation (the card's Open call). */
export async function openCall(page) {
  await page.locator(IX.cardOpenCall).first().click({ timeout: 10_000 });
  await page.locator(IX.call).first().waitFor({ state: 'visible', timeout: 15_000 });
}

/** Put the call view away again (Back to chat), still in the call. */
export async function backToChat(page) {
  await page.locator(IX.callBack).first().click({ timeout: 10_000 });
  await page.locator(IX.call).first().waitFor({ state: 'hidden', timeout: 15_000 });
}

/**
 * No Web Animation still running, for a screenshot of a settled state: every
 * Index motion is a WAAPI animation (spec 5), so "nothing running" is also the
 * fixture's answer to "has it finished".
 */
export async function settle(page, { timeoutMs = 4000, minMs = 500 } = {}) {
  await page.waitForTimeout(minMs);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const running = await page.evaluate(() =>
      document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length,
    ).catch(() => 0);
    if (running === 0) return;
    if (Date.now() > deadline) return;
    await page.waitForTimeout(150);
  }
}
