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
   * Watching Vincent's share with Sean in the call. Until G14 builds the Glass
   * stage this is whatever the current client shows for it: join Lounge, open
   * the share, and keep the frame in which Vincent's scene is on screen.
   */
  '04-side-by-side': {
    reference: '04-side-by-side.png',
    viewport: DESKTOP,
    async run({ page, go, session, log }) {
      // The lobby offers Watch beside a sharer: it joins and opens the share.
      // One attempt: a refused join (even a rejoin into a running call) is a
      // product failure to report, not something to retry past.
      await go('gameNight', 'lounge');
      await press(page, CONTROLS.watch, { timeoutMs: 45_000 });
      await awaitJoined(session, { log });
      // Sean has to *see* the share: its teal and amber on screen, not just a
      // stream canvas somewhere in the DOM. If the lobby's Watch did not bring
      // it up, take the Watch the call offers on Vincent's tile.
      const deadline = Date.now() + 60_000;
      let seen = await sceneOnScreen(page);
      let pressedTileWatch = false;
      while (!(seen.teal > 300 && seen.amber > 1500)) {
        if (Date.now() > deadline) {
          throw new Error(`Vincent's share never showed on Sean's screen (teal ${seen.teal}px, amber ${seen.amber}px)`);
        }
        if (!pressedTileWatch && Date.now() > deadline - 45_000) {
          const watch = await findControl(page, CONTROLS.watch);
          if (watch) { await watch.click().catch(() => {}); pressedTileWatch = true; }
        }
        await page.waitForTimeout(1000);
        seen = await sceneOnScreen(page);
      }
      log(`  ${' '.repeat(17)} Vincent's scene on screen: ${seen.teal}px teal, ${seen.amber}px amber${pressedTileWatch ? ' (via the tile\'s Watch)' : ''}`);
      // The watched share used to close itself about a second after joining
      // (docs/design/glass-fix-rejoin.md, Bug 2). The frame that was verified
      // is the one kept; say whether the share stayed, since it should.
      await page.waitForTimeout(3000);
      const later = await sceneOnScreen(page);
      if (!(later.teal > 300)) log(`  ${' '.repeat(17)} …and 3s later it is gone again (teal ${later.teal}px): the current stage dropped the share`);
      return { png: seen.png };
    },
    async after({ page, api, people, ids }) {
      const leave = await findControl(page, CONTROLS.leave);
      if (leave) await leave.click().catch(() => {});
      await leaveCall(api, people.sean, ids.servers.gameNight.channels.lounge);
      await page.waitForTimeout(1500);
    },
  },

  '05-theater': { reference: '05-theater.png', pending: 'G15 (theater)' },
  '06-browse': { reference: '06-browse.png', pending: 'G15 (browse)' },

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
