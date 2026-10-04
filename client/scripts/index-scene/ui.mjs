// Driving the app itself, for whichever interface the build under it has.
//
// The scene is meant to outlive the redesign it was written for: today the app
// is Glass, and from IX-4 on it is Index. Every action here has two paths and
// chooses by looking at the page, never by a flag:
//
//   index   the Index build, found by the sidebar's test id. Controls are the
//           docs/design/index-plan.md 1.3 test ids (`ix-card-join`,
//           `ix-room-row`, `ix-card-open-call`, `ix-card-leave`, ...) and the
//           accessible names the spec gives them. Written to the plan before
//           the components exist; the first run against a real Index build
//           (IX-7 onward) is its proof, and a control that is missing then is
//           reported by name, never worked around.
//   glass   today's build, through glass-scene/ui.mjs (its pill and stage).
//           Deleted when IX-19 retires Glass.
//
// Moving between places never reloads the page: a reload would drop the call
// the viewer is in and lock their encryption again. The router is told the URL
// changed instead, which is what clicking a link does.

import { chromium } from '@playwright/test';

import { mediaInitScript } from '../glass-scene/media-init.mjs';
import {
  MEDIA_ARGS, CONTROLS, closeCallStage, dismissOverlays, findControl, openCallStage, press, setToggle, waitForControl,
} from '../glass-scene/ui.mjs';

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

/** Which interface is on screen: 'index' when the Index sidebar is, else 'glass'. */
export async function uiKind(page) {
  return (await page.locator(IX.sidebar).count()) > 0 ? 'index' : 'glass';
}

/** Names the mic, camera and screen controls answer to in the Index card and call view. */
const INDEX_NAMES = {
  microphone: ['Microphone', 'Mute', 'Unmute', 'Mute microphone', 'Unmute microphone'],
  share: ['Share your screen', 'Share screen'],
  stopShare: ['Stop sharing your screen', 'Stop sharing'],
};

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

/**
 * The first of several candidate controls to be on screen, polling. Which
 * interface a control belongs to is decided by which one is there, not by what
 * the page is: while the build is half Glass and half Index (IX-4 to IX-19) the
 * Index frame is on screen with Glass's pill still in it.
 */
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

/** True once this page is connected to a call (Leave is on offer, in either interface). */
export async function isJoined(page) {
  if ((await page.locator(IX.cardLeave).count()) > 0) return true;
  return Boolean(await findControl(page, CONTROLS.leave));
}

/**
 * Join a room through the app's own controls and wait until the call is
 * connected. `textPath` is a text channel of the room's server (Index joins
 * from its card or room row there, Glass from its pill when the room is live);
 * `roomPath` is the room's own route (Glass joins an empty room from the pill
 * on it); `roomName` is what the UI calls the room.
 */
export async function joinRoom(session, { roomPath, textPath, roomName, log = () => {} }) {
  const { page } = session;
  if (await isJoined(page)) throw new Error(`${session.person.name} is already in a call; leave it before joining ${roomName}`);
  // The busiest room is the card; any other occupied or empty room is a row.
  const probes = {
    'ix-card-join': () => page.locator(IX.card).filter({ hasText: roomName }).locator(IX.cardJoin).first(),
    'ix-room-row': () => page.locator(IX.roomRow).filter({ hasText: roomName }).first(),
    'pill': () => page.getByRole('button', { name: `Join ${roomName}`, exact: true }).first(),
  };
  await navigate(page, textPath);
  let found = await firstVisible(page, probes, 8000);
  if (!found) {
    // An empty room has no card and no live pill: Glass joins it on its own route.
    await navigate(page, roomPath);
    found = await firstVisible(page, probes, 45_000);
  }
  if (!found) {
    throw new Error(`no way to join "${roomName}" appeared: neither ix-room-card/ix-card-join, ix-room-row, nor a "Join ${roomName}" button`);
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
  const leave = page.locator(IX.cardLeave).first();
  if (await leave.isVisible().catch(() => false)) await leave.click({ timeout: 5000 });
  else {
    const glass = await findControl(page, CONTROLS.leave);
    if (glass) await glass.click({ timeout: 5000 });
  }
  const deadline = Date.now() + 20_000;
  while (await isJoined(page)) {
    if (Date.now() > deadline) throw new Error(`${session.person.name} is still in the call 20s after pressing Leave`);
    await page.waitForTimeout(300);
  }
}

/** Switch the microphone on or off (a toggle whose state is `aria-pressed`). */
export async function setMic(session, on) {
  // The Index room card's mic is named for what it does ("Mute" / "Unmute") and
  // carries its state in `data-muted`, not `aria-pressed`.
  const cardMic = session.page.locator('[data-testid="ix-card-mic"]').first();
  if (await cardMic.isVisible().catch(() => false)) {
    const want = on ? 'false' : 'true';
    if ((await cardMic.getAttribute('data-muted')) !== want) await cardMic.click({ timeout: 5000 });
    const deadline = Date.now() + 15_000;
    while ((await cardMic.getAttribute('data-muted').catch(() => null)) !== want) {
      if (Date.now() > deadline) throw new Error(`the card's microphone did not turn ${on ? 'on' : 'off'} within 15s`);
      await session.page.waitForTimeout(300);
    }
    return;
  }
  await setToggle(session.page, [...INDEX_NAMES.microphone, ...CONTROLS.microphone], on, { timeoutMs: 15_000 });
}

/**
 * Start sharing the (canvas) screen. Index: the card's screen control, which
 * needs no stage. Glass: the stage's control row, then put the stage away again.
 */
export async function startShare(session) {
  const { page } = session;
  if (await findControl(page, INDEX_NAMES.share)) {
    await press(page, INDEX_NAMES.share);
    await waitForControl(page, INDEX_NAMES.stopShare, 30_000);
    return;
  }
  await openCallStage(page);
  await press(page, CONTROLS.share);
  await waitForControl(page, CONTROLS.stopShare, 30_000);
  await closeCallStage(page);
}

/** Open the call over the conversation (Index: Open call; Glass: Show the call). */
export async function openCall(page) {
  const open = page.locator(IX.cardOpenCall).first();
  if (await open.isVisible().catch(() => false)) {
    await open.click({ timeout: 10_000 });
    await page.locator(IX.call).first().waitFor({ state: 'visible', timeout: 15_000 });
  } else {
    await press(page, [...CONTROLS.showCall, ...CONTROLS.watch], { timeoutMs: 30_000 });
    await page.getByRole('group', { name: 'Call controls' }).waitFor({ state: 'visible', timeout: 30_000 });
  }
}

/** Put the call away again, still in it (Index: Back to chat; Glass: Close). */
export async function backToChat(page) {
  const back = page.locator(IX.callBack).first();
  if (await back.isVisible().catch(() => false)) {
    await back.click({ timeout: 10_000 });
    await page.locator(IX.call).first().waitFor({ state: 'hidden', timeout: 15_000 });
  } else {
    await closeCallStage(page);
  }
}

/**
 * No Web Animation still running, for a screenshot of a settled state: every
 * Index motion is a WAAPI animation (spec 5), so "nothing running" is also the
 * fixture's answer to "has it finished". Glass animations count the same way.
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
