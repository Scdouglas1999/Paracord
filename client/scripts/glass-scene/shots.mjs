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

/** Let a layout move finish: no Glass move still playing, no clone of what left. */
async function settleMove(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await page.evaluate(() =>
      document.getAnimations().filter(a => a.id.startsWith('glass-morph:') && a.playState === 'running').length
      + document.querySelectorAll('.glass-morph > *').length,
    );
    if (busy === 0) break;
    if (Date.now() > deadline) throw new Error(`a layout move did not settle within ${timeoutMs / 1000}s (${busy} parts still moving)`);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(250);
}

/** Vincent's scene is in the stage's stream right now; a frame of the whole window. */
async function stageFrameNow(page, log) {
  const box = await page.locator('.glass-frame__stage .glass-stage__stream').first().boundingBox();
  const seen = await sceneOnScreen(page, box ?? undefined);
  if (!(seen.teal > 300 && seen.amber > 1500)) {
    throw new Error(`Vincent's share is not in the stage (teal ${seen.teal}px, amber ${seen.amber}px)`);
  }
  log(`  ${' '.repeat(17)} Vincent's scene in the stage: ${seen.teal}px teal, ${seen.amber}px amber`);
  return { png: (await sceneOnScreen(page)).png };
}

/** Messages posted for a state, removed again afterwards so later states see the seeded scene. */
const posted = [];

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

  /**
   * Listening in to the Lounge from General, the pill grown to show who is there
   * (screens/03), through the pill's own controls: Listen, then the faces. The
   * relay must count Sean as a listener, never as joined.
   */
  '03-listen': {
    reference: '03-listen.png',
    viewport: DESKTOP,
    async run({ page, go, api, people, ids, log }) {
      await go('gameNight', 'general');
      await settleOn(page, 'bringing the projector');
      await press(page, ['Listen in to Lounge'], { timeoutMs: 45_000 });
      await page.getByRole('button', { name: 'Stop listening in to Lounge' }).waitFor({ state: 'visible', timeout: 45_000 });
      const lounge = ids.servers.gameNight.channels.lounge;
      const states = await api.request(people.sean.token, 'GET', `/api/v1/guilds/${ids.servers.gameNight.id}/voice-states`).catch(() => null);
      const mine = Array.isArray(states) ? states.find(s => String(s.user_id) === people.sean.id && String(s.channel_id) === lounge) : null;
      if (mine) log(`  ${' '.repeat(17)} the server has Sean in the Lounge as mode "${mine.mode ?? 'joined'}"`);
      await press(page, ["Show who's in Lounge"]);
      await page.getByText("Everyone in Lounge can see you're listening in.").waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(1200);
    },
    async after({ page, api, people, ids }) {
      const stop = await findControl(page, ['Stop listening in to Lounge']);
      if (stop) await stop.click().catch(() => {});
      await leaveCall(api, people.sean, ids.servers.gameNight.channels.lounge);
      await page.waitForTimeout(1500);
    },
  },

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

  /**
   * Theater, joined, chat hidden, two messages surfacing (screens/05), through
   * the Glass controls: the pill's Join and Watch, the stage's theater button,
   * then its chat button. Nick and Jeremy then post in General (the
   * conversation that was hidden) through the API, as they would from their
   * own clients; Jeremy's mentions Sean. Both are deleted again afterwards.
   */
  '05-theater': {
    reference: '05-theater.png',
    viewport: DESKTOP,
    async run({ page, go, session, log, api, people, ids }) {
      await go('gameNight', 'general');
      await settleOn(page, 'bringing the projector');
      await press(page, ['Join Lounge'], { timeoutMs: 45_000 });
      await awaitJoined(session, { log });
      await press(page, CONTROLS.watch, { timeoutMs: 30_000 });
      await keepStageFrame(page, log);
      await settleMove(page);
      await press(page, CONTROLS.theater, { timeoutMs: 10_000 });
      await settleMove(page);
      await page.locator('.glass-stage[data-mode="theater"]').waitFor({ timeout: 10_000 });
      await press(page, CONTROLS.hideChat, { timeoutMs: 10_000 });
      await settleMove(page);
      if (await page.getByRole('main').getAttribute('data-away') !== 'true') throw new Error('the chat did not hide');
      const general = ids.servers.gameNight.channels.general;
      posted.push({ channel: general, token: people.nick.token, message: await api.request(people.nick.token, 'POST', `/channels/${general}/messages`, { content: 'that flare placement was perfect' }) });
      await page.waitForTimeout(350);
      posted.push({ channel: general, token: people.jeremy.token, message: await api.request(people.jeremy.token, 'POST', `/channels/${general}/messages`, { content: `<@${people.sean.id}> is movie night still on?` }) });
      await page.getByRole('button', { name: /^Show chat, 2 new messages$/ }).waitFor({ timeout: 15_000 });
      log(`  ${' '.repeat(17)} two messages surfaced over the stream`);
      await page.waitForTimeout(700);
      return stageFrameNow(page, log);
    },
    async after({ page, api, people, ids }) {
      for (const { channel, token, message } of posted.splice(0)) {
        await api.request(token, 'DELETE', `/channels/${channel}/messages/${message.id}`).catch(() => {});
      }
      const stop = await findControl(page, CONTROLS.stopWatching);
      if (stop) await stop.click().catch(() => {});
      const leave = await findControl(page, CONTROLS.leave);
      if (leave) await leave.click().catch(() => {});
      await leaveCall(api, people.sean, ids.servers.gameNight.channels.lounge);
      await page.waitForTimeout(1500);
    },
  },
  /**
   * Browsing while watching, not joined (screens/06): Watch from the pill, then
   * the stage's sidebar button (S), which slides places back in and grows the
   * stage to 1076 (WP-G15's move; the resting layout is the frame's, WP-G7,
   * and the stage's, WP-G14).
   */
  '06-browse': {
    reference: '06-browse.png',
    viewport: DESKTOP,
    unread: true,
    async run({ page, go, log }) {
      await go('gameNight', 'clips');
      await press(page, CONTROLS.watch, { timeoutMs: 30_000 });
      await keepStageFrame(page, log);
      await settleMove(page);
      await press(page, CONTROLS.browse, { timeoutMs: 10_000 });
      await settleMove(page);
      const stage = await page.getByRole('region', { name: 'Stage' }).boundingBox();
      const places = await page.locator('.glass-frame__places').boundingBox();
      if (!places) throw new Error('the places panel did not slide in');
      if (!stage || Math.round(stage.width) !== 1076) throw new Error(`the stage is ${stage ? Math.round(stage.width) : 'not'} wide while browsing, not 1076`);
      log(`  ${' '.repeat(17)} browsing: places at ${Math.round(places.x)}, stage ${Math.round(stage.x)} w${Math.round(stage.width)}`);
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
