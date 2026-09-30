// Named states of Sean's view, captured to
// output/design-reference/glass-build/live/<state>.png.
//
// A state is one small object:
//
//   '05-theater': {
//     reference: '05-theater.png',            // the render it is held against
//     viewport: { width: 1440, height: 900 },
//     unread: true,                           // put Sean's unread marks back first
//     async run({ page, go, ids, press, ... }) { ... navigate and wait ... },
//     async after({ page, ... }) { ... undo anything that would leak ... },
//   }
//
// `run` leaves the page showing the state and the driver takes the screenshot,
// or `run` returns `{ png }` — a frame it has already verified — to keep that.
// A state with `pending` names the package that will make it reachable and is
// skipped by `--shot all` until then.

import { leaveCall } from './call.mjs';
import { CONTROLS, awaitJoined, dismissOverlays, findControl, press, sceneOnScreen } from './ui.mjs';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Wait for text in the timeline, then let entrance motion finish. */
async function settleOn(page, text, timeoutMs = 30_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs });
  await dismissOverlays(page, 500, 3000);
  await page.waitForTimeout(1500);
}

/**
 * Wait until Vincent's scene is on screen inside the stage's stream (its teal
 * and amber, counted in a fresh screenshot of that box) and return a frame of
 * the whole window taken then. A share that goes away again a few seconds later
 * is reported: the watch must never close itself (docs/design/glass-fix-rejoin.md, Bug 2).
 */
async function keepStageFrame(page, log) {
  const stream = page.locator('.glass-stage__stream').first();
  await stream.waitFor({ state: 'visible', timeout: 30_000 });
  const deadline = Date.now() + 60_000;
  let seen = { teal: 0, amber: 0 };
  for (;;) {
    const box = await stream.boundingBox();
    seen = await sceneOnScreen(page, box ?? undefined);
    if (seen.teal > 300 && seen.amber > 1500) break;
    if (Date.now() > deadline) {
      throw new Error(`Vincent's share never showed in the stage (teal ${seen.teal}px, amber ${seen.amber}px)`);
    }
    await page.waitForTimeout(1000);
  }
  log(`  ${' '.repeat(17)} Vincent's scene in the stage: ${seen.teal}px teal, ${seen.amber}px amber`);
  await page.waitForTimeout(3000);
  const box = await stream.boundingBox();
  const later = await sceneOnScreen(page, box ?? undefined);
  if (!(later.teal > 300)) log(`  ${' '.repeat(17)} …and 3s later it is gone again (teal ${later.teal}px)`);
  const full = await sceneOnScreen(page);
  return { png: full.png };
}

export const STATES = {
  '01-conversation': {
    reference: '01-conversation.png',
    viewport: DESKTOP,
    unread: true,
    async run({ page, go }) {
      await go('gameNight', 'general');
      await settleOn(page, 'bringing the projector');
    },
  },

  '02-quiet': {
    reference: '02-quiet.png',
    viewport: DESKTOP,
    unread: true,
    async run({ page, go }) {
      await go('basecamp', 'trips');
      await settleOn(page, 'bring layers');
    },
  },

  '03-listen': { reference: '03-listen.png', pending: 'G6 + G12 (listen-in and the call pill)' },

  /**
   * Watching Vincent's share beside General, joined (screens/04), through the
   * Glass controls: the call pill's Join, then its Watch, which grows the stage
   * (WP-G14). The kept frame is one in which Vincent's scene is on screen inside
   * the stage's stream, not just a canvas somewhere in the DOM.
   */
  '04-side-by-side': {
    reference: '04-side-by-side.png',
    viewport: DESKTOP,
    async run({ page, go, session, log }) {
      // One attempt: a refused join (even a rejoin into a running call) is a
      // product failure to report, not something to retry past.
      await go('gameNight', 'general');
      await settleOn(page, 'bringing the projector');
      await press(page, ['Join Lounge'], { timeoutMs: 45_000 });
      await awaitJoined(session, { log });
      await press(page, CONTROLS.watch, { timeoutMs: 30_000 });
      return keepStageFrame(page, log);
    },
    async after({ page, api, people, ids }) {
      const stop = await findControl(page, CONTROLS.stopWatching);
      if (stop) await stop.click().catch(() => {});
      const leave = await findControl(page, CONTROLS.leave);
      if (leave) await leave.click().catch(() => {});
      await leaveCall(api, people.sean, ids.servers.gameNight.channels.lounge);
      await page.waitForTimeout(1500);
    },
  },

  '05-theater': { reference: '05-theater.png', pending: 'G15 (theater)' },
  /**
   * Browsing while watching, not joined (screens/06): Watch from the pill, then
   * the stage's sidebar button (S). The move between the two is WP-G15's; the
   * resting layout is the frame's (WP-G7) and the stage's (WP-G14).
   */
  '06-browse': {
    reference: '06-browse.png',
    viewport: DESKTOP,
    unread: true,
    async run({ page, go, log }) {
      await go('gameNight', 'clips');
      await press(page, CONTROLS.watch, { timeoutMs: 30_000 });
      await keepStageFrame(page, log);
      await press(page, CONTROLS.browse, { timeoutMs: 10_000 });
      await page.waitForTimeout(1200);
      return keepStageFrame(page, log);
    },
    async after({ page }) {
      const stop = await findControl(page, CONTROLS.stopWatching);
      if (stop) await stop.click().catch(() => {});
      await page.waitForTimeout(800);
    },
  },

  /** The phone frame of General; the Glass phone shell arrives with G20. */
  '07-phone': {
    reference: '07-phone.png',
    viewport: PHONE,
    unread: true,
    async run({ page, go }) {
      await go('gameNight', 'general');
      await settleOn(page, 'bringing the projector');
    },
  },
};

export function resolveStates(arg) {
  if (!arg || arg === 'all') {
    return Object.entries(STATES).map(([name, state]) => ({ name, ...state }));
  }
  return arg.split(',').map(name => {
    const state = STATES[name.trim()];
    if (!state) throw new Error(`no state named "${name}". Known: ${Object.keys(STATES).join(', ')}`);
    return { name: name.trim(), ...state, explicit: true };
  });
}
