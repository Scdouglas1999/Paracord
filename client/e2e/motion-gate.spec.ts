import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';

import {
  CH,
  GUILD,
  HISTORY_EPOCH,
  ME,
  actionCard,
  at,
  channelRow,
  composerInput,
  dockItem,
  installIndexScene,
  roomCard,
  scrollConversation,
  type IndexHarness,
} from './fixtures/index';
import { share, speak, voiceJoin, voiceLeave } from './fixtures/index/steps/motion';
import { describeMoment, installMotionRecorder, markMoment, runningNow, type MotionRecord } from './fixtures/motionFixture';

/**
 * The Index motion gate (docs/index-spec.md §5, §10; docs/design/index-plan.md
 * §3 IX-18, §5.4).
 *
 * The owner's bar: "really slick animations around the app for different
 * things, without being overbearing and having everything moving all the
 * time". So the gate holds two things, for every moment of §5:
 *
 *   THE MOMENT. Each animation that IS the moment runs exactly the spec's
 *   duration, on the spec's curve (spring `cubic-bezier(.32,.72,0,1)` or ease
 *   `cubic-bezier(.2,.8,.2,1)`), from the spec's start (`translateY(14px)
 *   scale(.96)`, opacity .3, ...). The numbers are the spec's, cited by section
 *   at each assertion, never the app's own constants read back: a constant that
 *   drifts from §5 fails here.
 *
 *   THE LAW. Only `transform` and `opacity` move (plus colors, which §5.13 and
 *   §5.15 allow: a background or ink stepping one shade). Any other animated
 *   property in any moment fails the gate by name (`height`, `boxShadow`,
 *   `filter`, `width`, ...); `scripts/motion-lint.mjs` keeps the same rule in
 *   the source. Nothing loops but the talking waveform, and that only while
 *   somebody talks.
 *
 *   QUIET AT REST. Two seconds after each moment settles,
 *   `document.getAnimations()` is empty (§1.2 "Quiet at rest, alive on
 *   events"; plan §5.4.4: the WebKitGTK desktop's idle CPU is a design
 *   constraint). While somebody talks, the waveform is the one exception, and
 *   the talking-ring case proves it stops when they do.
 *
 *   REDUCED MOTION. Every move becomes a 65ms opacity crossfade; pings and
 *   lifts are gone; the waveform is still (§5, opening paragraph).
 *
 * How it hears every animation: `fixtures/motionFixture.ts` wraps
 * `Element.prototype.animate` and listens for `transitionrun` and
 * `animationstart` before the app loads, so a moment's record is complete, not
 * a sample of what a frame happened to see.
 *
 * NOT A MOMENT OF THIS GATE'S CEILINGS: the send flight (§5.11), the owner's
 * favorite and protected gesture (docs/design/index-checkpoints/M1.md). It is
 * filmed and measured by `e2e/index-send.spec.ts`; here one case only guards
 * that nobody clamps it (it still flies its 185ms arc, well past 8px).
 *
 * Run:
 *   cd client
 *   npm run test:motion            (playwright.config.ts, ports 4173/4175;
 *                                   PARACORD_E2E_APP_PORT=<p> for p / p + 2)
 *   PARACORD_E2E_INDEX_SPEC=motion-gate PARACORD_E2E_INDEX_PORT=4663 \
 *   PARACORD_E2E_INDEX_RT_PORT=4665 PARACORD_E2E_INDEX_WP=ix18 \
 *   npx playwright test -c e2e/index-review.config.ts
 *
 * The scene is the Index review harness (`fixtures/index`, IX-0); the one-event
 * steps it needs are `fixtures/index/steps/motion.ts`.
 */

/* ---- The spec's curves --------------------------------------------------------- */

/** §5: spring, `cubic-bezier(.32,.72,0,1)` (as the engine spells it back). */
const SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** §5: ease, `cubic-bezier(.2,.8,.2,1)`. */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** §5 does not name the curve (a plain fade): any is fine. */
const ANY = '*';

/** §5: reduced motion replaces every move with a 65ms opacity crossfade. */
const REDUCED_MS = 65;
/** §5.4 plan: quiet two seconds after a moment settles. */
const REST_MS = 2_000;

/** The properties a moment may animate: transform and opacity (§1.9, §5). */
const LAW = new Set(['transform', 'opacity', 'transformOrigin', 'translate', 'scale', 'rotate']);
/** Colors may step (§5.13 send control, §5.15 rows and controls, §4.9 toolbar fill). */
const COLORS = new Set(['color', 'backgroundColor', 'borderColor', 'outlineColor', 'fill', 'stroke', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor']);

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  timezoneId: 'America/Chicago',
  locale: 'en-US',
});
test.describe.configure({ timeout: 150_000 });

/* ---- What a moment must be ------------------------------------------------------ */

interface Play {
  /** What it is, and where §5 says so. */
  cites: string;
  match: (record: MotionRecord) => boolean;
  /** ms, the spec's. */
  duration: number;
  /** SPRING, EASE, a literal, or ANY. */
  curve: string;
  delay?: number;
  /** The first keyframe's transform (a string, or a pattern). */
  fromTransform?: string | RegExp;
  /** The last keyframe's transform. */
  toTransform?: string | RegExp;
  /** The opacity keyframes, in order. */
  opacities?: string[];
  /** Properties it must move (beyond the law). */
  moves?: Array<'transform' | 'opacity'>;
  atLeast?: number;
  atMost?: number;
}

interface Moment {
  plays: Play[];
  /** Ids or names that must NOT play in this moment (a retired recipe, a ping on the current place). */
  absent?: Array<{ cites: string; match: (record: MotionRecord) => boolean }>;
}

const describe = (record: MotionRecord) =>
  `${record.kind}:${record.id}@${record.target} ${record.duration ?? 'loop'}ms ${record.easing}`
  + `${record.keyframeEasings.length ? ` [${record.keyframeEasings.join('|')}]` : ''}`
  + ` {${record.properties.join(',')}} T[${record.transforms.join(' > ')}] O[${record.opacities.join(' > ')}]`;

const curveOf = (record: MotionRecord) => (record.keyframeEasings.length > 0 && record.easing === 'linear' ? record.keyframeEasings[0] : record.easing);

/**
 * Every rule of the gate applied to one moment's record. Throws (a failed
 * expect) naming the moment, the section, and the animation. Pure on purpose:
 * the self-test hands it a record with a forbidden property and expects a throw.
 */
function expectMoment(label: string, records: MotionRecord[], moment: Moment): void {
  const log = records.map(describe).join('\n    ');
  if (process.env.PARACORD_E2E_MOTION_VERBOSE) console.log(`[motion-gate] ${label}\n    ${log}`);

  for (const play of moment.plays) {
    const matched = records.filter(play.match);
    expect(matched.length, `${label}: ${play.cites} did not play\n    saw:\n    ${log}`).toBeGreaterThanOrEqual(play.atLeast ?? 1);
    if (play.atMost !== undefined) {
      expect(matched.length, `${label}: ${play.cites} played ${matched.length} times`).toBeLessThanOrEqual(play.atMost);
    }
    for (const record of matched) {
      const name = `${label}: ${play.cites} (${describe(record)})`;
      expect(record.duration, `${name}: duration`).toBe(play.duration);
      if (play.curve !== ANY) expect(curveOf(record), `${name}: curve`).toBe(play.curve);
      expect(record.delay, `${name}: delay`).toBe(play.delay ?? 0);
      if (play.fromTransform !== undefined) expect(record.transforms[0], `${name}: from`).toMatch(play.fromTransform);
      if (play.toTransform !== undefined) expect(record.transforms.at(-1), `${name}: to`).toMatch(play.toTransform);
      if (play.opacities) expect(record.opacities, `${name}: opacity`).toEqual(play.opacities);
      for (const property of play.moves ?? []) expect(record.properties, `${name}: moves ${property}`).toContain(property);
    }
  }

  for (const absent of moment.absent ?? []) {
    const played = records.filter(absent.match);
    expect(played.map(describe), `${label}: ${absent.cites}`).toEqual([]);
  }

  // The law: transform and opacity (and colors) only, everywhere in the window.
  const illegal: string[] = [];
  for (const record of records) {
    for (const property of record.properties) {
      if (LAW.has(property) || COLORS.has(property)) continue;
      illegal.push(`${property} in ${describe(record)}`);
    }
  }
  expect(illegal, `${label}: only transform and opacity move (§1.9, §5); colors may step`).toEqual([]);

  // Nothing loops but the waveform, and only while someone talks.
  const loops = records.filter((record) => record.loops && !record.talking).map(describe);
  expect(loops, `${label}: nothing loops (§1.2: "no idle loops")`).toEqual([]);
}

/* ---- Matchers -------------------------------------------------------------------- */

const web = (id: string) => (record: MotionRecord) => record.kind === 'web' && record.id === id;
const webOn = (id: string, target: string) => (record: MotionRecord) => web(id)(record) && record.target.includes(target);
const transition = (property: string, target: string) => (record: MotionRecord) =>
  record.kind === 'transition' && record.id === property && record.target.includes(target);
const cssAnimation = (name: string, target?: string) => (record: MotionRecord) =>
  record.kind === 'animation' && record.id === name && (target === undefined || record.target.includes(target));
/** A transition going toward a value (a reversed, shortened one is another moment). */
const toward = (match: (record: MotionRecord) => boolean, end: RegExp) => (record: MotionRecord) =>
  match(record) && end.test(record.transforms.at(-1) ?? record.opacities.at(-1) ?? '');

/* ---- The harness ---------------------------------------------------------------- */

/**
 * The realtime stub's port: the index-review config passes it; under
 * `npm run test:motion` (playwright.config.ts) it is the app's port + 2
 * (4173 / 4175), the convention every e2e config here keeps.
 */
function stubPort(info: TestInfo): number {
  const fromEnv = process.env.PARACORD_E2E_INDEX_RT_PORT;
  if (fromEnv) return Number(fromEnv);
  const base = info.project.use.baseURL ?? 'http://127.0.0.1:4173';
  return Number(new URL(base).port) + 2;
}

async function open(page: Page, info: TestInfo, route?: (h: IndexHarness) => string): Promise<IndexHarness> {
  await installMotionRecorder(page);
  const h = await installIndexScene(page, { video: false, rtPort: stubPort(info) });
  await h.open(route ? route(h) : h.routes.channel('fuelGeneral'));
  await page.evaluate(() => document.fonts.ready);
  await park(page);
  await rest(page, 'the page after load');
  return h;
}

/** The pointer goes where it hovers nothing. */
async function park(page: Page): Promise<void> {
  await page.mouse.move(1279, 799);
}

/**
 * Quiet at rest: wait until nothing is animating (the moment has settled),
 * then two more seconds, and `document.getAnimations()` must be empty (the
 * talking waveform aside, unless `strict`).
 *
 * A moment may set off a later one by design, an event of its own: the New
 * divider fades two seconds after you have read to the bottom (IX-11), "Link
 * copied" turns back after two seconds (§5.16). Those settle too, so the wait
 * starts again (up to three times); a loop never settles and fails here.
 */
async function rest(page: Page, label: string, { strict = false }: { strict?: boolean } = {}): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await expect
      .poll(() => runningNow(page, { talking: strict }), { message: `${label}: the moment never settled`, timeout: 8_000 })
      .toEqual([]);
    await page.waitForTimeout(REST_MS);
    if ((await runningNow(page, { talking: strict })).length === 0) return;
  }
  expect(await runningNow(page, { talking: strict }), `${label}: something is still animating ${REST_MS}ms after it settled`).toEqual([]);
}

/**
 * One moment: mark, act, let it settle and rest, and hold its record to the
 * spec. Returns the record for anything the case checks on its own.
 */
async function moment(page: Page, label: string, act: () => Promise<unknown>, spec: Moment, { strict = false } = {}): Promise<MotionRecord[]> {
  await markMoment(page);
  await act();
  await rest(page, label, { strict });
  const records = await describeMoment(page);
  expectMoment(label, records, spec);
  return records;
}

/** The scene's clock moved on (a message "now" sorts after what came before). */
async function later(h: IndexHarness, time: string): Promise<void> {
  await h.setClock(at(time));
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH }, body: JSON.stringify(body) });

/* ---- The moments ------------------------------------------------------------------ */

test.describe('the Index motion gate (index-spec §5)', () => {
  test('§5.1 switching place: panes slide by dock order, the tint crossfades, the indicator glides, main comes in', async ({ page }, info) => {
    await open(page, info);
    const right = {
      plays: [
        { cites: '§5.1 old pane: translateX(-dir×40%), 1→0, 135ms spring', match: web('ix-pane:out'), duration: 135, curve: SPRING, fromTransform: 'none', toTransform: 'translateX(-40%)', opacities: ['1', '0'], atMost: 1 },
        { cites: '§5.1 new pane: from translateX(dir×60%), 0→1, 165ms spring', match: web('ix-pane:in'), duration: 165, curve: SPRING, fromTransform: 'translateX(60%)', toTransform: 'none', opacities: ['0', '1'], atMost: 1 },
        { cites: '§5.1 the sidebar tint fades in over the old, 275ms ease', match: web('ix-tint:side'), duration: 275, curve: EASE, opacities: ['0', '1'], atMost: 1 },
        { cites: '§5.1 main glow, the same', match: web('ix-tint:main'), duration: 275, curve: EASE, opacities: ['0', '1'], atMost: 1 },
        { cites: '§5.1 dock indicator glides, 165ms spring', match: web('ix-dock:indicator'), duration: 165, curve: SPRING, moves: ['transform'], atMost: 1 },
        { cites: '§5.1 the new place’s mark scales to 1.08, 135ms spring', match: toward(transition('transform', 'ix-dock__mark'), /scale\(1\.08\)/), duration: 135, curve: SPRING },
        { cites: '§5.1 the old mark back to 1, 135ms spring', match: toward(transition('transform', 'ix-dock__mark'), /^none$/), duration: 135, curve: SPRING },
        { cites: '§5.1/5.2 main title: a place switch comes in as the prototype plays it (dir 0): from translateY(4px), 125ms spring', match: web('ix-main:title'), duration: 125, curve: SPRING, fromTransform: 'translateY(4px)', opacities: ['0', '1'] },
        { cites: '§5.1/5.2 main feed: from translateY(0), fading, 145ms spring', match: web('ix-main:feed'), duration: 145, curve: SPRING, fromTransform: 'translateY(0px)', opacities: ['0', '1'] },
      ],
      absent: [{ cites: 'the Glass route crossfade (4px, 75ms) is retired in the Index frame', match: web('data-motion-recipe:content') }],
    } satisfies Moment;
    await moment(page, 'Fuel → Game Night', () => dockItem(page, 'gameNight').click(), right);
    await park(page);
    await moment(page, 'Game Night → Fuel (leftward)', () => dockItem(page, 'fuel').click(), {
      plays: [
        { cites: '§5.1 old pane leaves to the right: translateX(40%)', match: web('ix-pane:out'), duration: 135, curve: SPRING, toTransform: 'translateX(40%)' },
        { cites: '§5.1 new pane from the left: translateX(-60%)', match: web('ix-pane:in'), duration: 165, curve: SPRING, fromTransform: 'translateX(-60%)' },
        { cites: '§5.1 tint', match: web('ix-tint:side'), duration: 275, curve: EASE },
        { cites: '§5.1 indicator', match: web('ix-dock:indicator'), duration: 165, curve: SPRING },
      ],
    });
    // One pane and one tint layer each at rest.
    await expect(page.locator('.ix-pane')).toHaveCount(1);
    await expect(page.locator('[data-ix-tint="side"]')).toHaveCount(1);
  });

  test('§5.2 switching channel: the selection glides, the title and feed come in from the direction it moved', async ({ page }, info) => {
    await open(page, info, (h) => h.routes.channel('gnLounge'));
    const down = await moment(page, 'lounge → looking-for-group (down)', () => channelRow(page, 'gnLfg').click(), {
      plays: [
        { cites: '§5.2 selection translateY to the new row, 135ms spring (no height)', match: web('ix-select:glide'), duration: 135, curve: SPRING, fromTransform: /^translateY\(/, moves: ['transform'], atMost: 1 },
        { cites: '§5.2 title from translateY(dir×14+4 = 18px), 125ms spring', match: web('ix-main:title'), duration: 125, curve: SPRING, fromTransform: 'translateY(18px)', opacities: ['0', '1'] },
        { cites: '§5.2 feed from translateY(dir×22 = 22px), 145ms spring', match: web('ix-main:feed'), duration: 145, curve: SPRING, fromTransform: 'translateY(22px)', opacities: ['0', '1'] },
      ],
      absent: [{ cites: 'the Glass route crossfade is retired', match: web('data-motion-recipe:content') }],
    });
    await park(page);
    const up = await moment(page, 'looking-for-group → lounge (up)', () => channelRow(page, 'gnLounge').click(), {
      plays: [
        { cites: '§5.2 the glide back up', match: web('ix-select:glide'), duration: 135, curve: SPRING },
        { cites: '§5.2 title from translateY(-14+4 = -10px)', match: web('ix-main:title'), duration: 125, curve: SPRING, fromTransform: 'translateY(-10px)' },
        { cites: '§5.2 feed from translateY(-22px)', match: web('ix-main:feed'), duration: 145, curve: SPRING, fromTransform: 'translateY(-22px)' },
      ],
    });
    // §4.9: the toolbar's fill follows a real fold only: two short channels, so it never flashes between them.
    for (const records of [down, up]) {
      expect(records.filter(transition('background-color', 'ix-toolbar')).map(describe), '§4.9 the toolbar fill only follows a real fold').toEqual([]);
    }
  });

  test('§5.3 a preview changes: the new line rolls up, the time fades in, the unread dot scales in and out', async ({ page }, info) => {
    const h = await open(page, info);
    await later(h, '21:39:30');
    await moment(page, 'a message in plans', () => h.step('message', { channel: 'fuelPlans', who: 'jeremy', text: 'movie friday?' }), {
      plays: [
        { cites: '§5.3 the line from translateY(9px), opacity 0, 155ms spring', match: web('ix-preview:line'), duration: 155, curve: SPRING, fromTransform: 'translateY(9px)', opacities: ['0', '1'], atMost: 1 },
        { cites: '§5.3 the time fades in, 120ms', match: web('ix-preview:time'), duration: 120, curve: ANY, opacities: ['0', '1'], atMost: 1 },
        { cites: '§5.3 the unread dot scales 0→1, 135ms spring', match: toward(transition('transform', 'ix-ch__dot'), /scale\(1\)/), duration: 135, curve: SPRING },
      ],
    });
    const reading = await moment(page, 'reading plans', () => channelRow(page, 'fuelPlans').click(), {
      plays: [{ cites: '§5.3 the dot scales 1→0 when read, 135ms spring', match: toward(transition('transform', 'ix-ch__dot'), /scale\(0\)/), duration: 135, curve: SPRING }],
    });
    // §4.9: a channel whose history has not said yet where it starts (it only has
    // what the gateway brought) does not flash the toolbar's fill while it loads.
    expect(reading.filter(transition('background-color', 'ix-toolbar')).map(describe), '§4.9 no fill flash on a switch').toEqual([]);
  });

  test('§5.5 a room goes live, people come and go, it empties; the dock pings once for another server', async ({ page }, info) => {
    const h = await open(page, info);
    await moment(page, 'Jeremy joins General (the room goes live)', () => h.step(voiceJoin, { who: 'jeremy', room: 'fuelRoomGeneral' }), {
      plays: [
        { cites: '§5.5 the card enters: translateY(-8px) scale(.97), 0→1, 185ms spring (a 35ms beat behind the push it causes, IX-18)', match: web('ix-card:card-in'), duration: 185, delay: 35, curve: SPRING, fromTransform: 'translateY(-8px) scale(0.97)', opacities: ['0', '1'], atMost: 1 },
        { cites: '§5.5 what is below moves down by FLIP, 185ms spring', match: webOn('ix-card:push', 'ix-sb__rows'), duration: 185, curve: SPRING, moves: ['transform'] },
        { cites: '§5.5 the dock’s live dot scales in, 135ms spring', match: toward(transition('transform', 'ix-dock__live'), /scale\(1\)/), duration: 135, curve: SPRING },
      ],
      absent: [{ cites: '§5.5 no ping for the server you are looking at', match: web('ix-dock:ping') }],
    });
    await moment(page, 'Nick joins (a row enters)', () => h.step(voiceJoin, { who: 'nick', room: 'fuelRoomGeneral' }), {
      plays: [
        { cites: '§5.5 a person row enters the same way, 150ms spring', match: web('ix-card:row-in'), duration: 150, curve: SPRING, fromTransform: 'translateY(-8px) scale(0.97)', opacities: ['0', '1'], atMost: 1 },
        { cites: '§5.5 rows and actions below move down, 150ms', match: web('ix-card:push'), duration: 150, curve: SPRING },
      ],
    });
    await moment(page, 'Nick leaves (a row leaves)', () => h.step(voiceLeave, { who: 'nick', room: 'fuelRoomGeneral' }), {
      plays: [
        { cites: '§5.5 a leaving row fades and scales to .97, 75ms ease', match: web('ix-card:row-out'), duration: 75, curve: EASE, toTransform: 'scale(0.97)', opacities: ['1', '0'], atMost: 1 },
        { cites: '§5.5 then rows below FLIP up, 135ms spring', match: web('ix-card:push'), duration: 135, curve: SPRING },
        { cites: '§5.5 … the sidebar under the card too, once the row has gone', match: webOn('ix-card:push', 'ix-sb__rows'), duration: 135, curve: SPRING, atMost: 1 },
      ],
    });
    await moment(page, 'Jeremy leaves (the room empties)', () => h.step(voiceLeave, { who: 'jeremy', room: 'fuelRoomGeneral' }), {
      plays: [
        { cites: '§5.5 the card reverses, 90ms ease', match: web('ix-card:card-out'), duration: 90, curve: EASE, opacities: ['1', '0'], atMost: 1 },
        { cites: '§5.5 and the list FLIPs up once, 135ms spring', match: webOn('ix-card:push', 'ix-sb__rows'), duration: 135, curve: SPRING, atMost: 1 },
        { cites: '§5.5 the live dot scales out', match: toward(transition('transform', 'ix-dock__live'), /scale\(0\)/), duration: 135, curve: SPRING },
      ],
    });
    const pinged = await moment(page, 'Basecamp goes live (another server)', () => h.step(voiceJoin, { who: 'brendan', room: 'bcRoomWorkshop' }), {
      plays: [
        { cites: '§5.5 the dock pings once: a ring from scale(1), 1 to scale(2.2), 0, 365ms ease', match: web('ix-dock:ping'), duration: 365, curve: EASE, fromTransform: 'scale(1)', toTransform: 'scale(2.2)', opacities: ['1', '0'], atLeast: 1, atMost: 1 },
        { cites: '§5.5 its live dot scales in', match: toward(transition('transform', 'ix-dock__live'), /scale\(1\)/), duration: 135, curve: SPRING },
      ],
    });
    expect(pinged.filter(web('ix-dock:ping'))[0]?.target).toContain('ix-dock__ping');
    // §10: the same moment in words.
    await expect(page.getByTestId('ix-announcer')).toContainText('Basecamp is live');
  });

  test('§5.4 the pinned call card: still between other places, a FLIP to and from its own server', async ({ page }, info) => {
    const h = await open(page, info);
    await h.step('arrive');
    await h.step('join');
    await rest(page, 'joined');
    await moment(page, 'Fuel → Game Night (the card pins above the header)', () => dockItem(page, 'gameNight').click(), {
      plays: [
        { cites: '§5.4 the card FLIPs between "under the search" and "above the header", 165ms spring, translate only', match: web('ix-card:pin'), duration: 165, curve: SPRING, fromTransform: /^translate\(0px, -?\d/, toTransform: 'none', atLeast: 1, atMost: 1 },
        { cites: '§5.1 while the panes slide beneath', match: web('ix-pane:in'), duration: 165, curve: SPRING },
      ],
    });
    await park(page);
    await moment(page, 'Game Night → Basecamp (the pinned card stays still)', () => dockItem(page, 'basecamp').click(), {
      plays: [{ cites: '§5.1 panes slide', match: web('ix-pane:in'), duration: 165, curve: SPRING }],
      absent: [
        { cites: '§5.4 switching between other places leaves the card still', match: web('ix-card:pin') },
        { cites: '§5.4 nothing of the pinned card moves', match: (record) => record.target.includes('ix-room-card') },
      ],
    });
    await park(page);
    await moment(page, 'Basecamp → Fuel (back under the search)', () => dockItem(page, 'fuel').click(), {
      plays: [{ cites: '§5.4 the FLIP home, 165ms spring', match: web('ix-card:pin'), duration: 165, curve: SPRING, toTransform: 'none', atMost: 1 }],
    });
  });

  test('§5.6 Plan a night grows the draft out of the action card; §5.15 the card lifts 3px', async ({ page }, info) => {
    await open(page, info);
    await moment(page, 'hovering an action card', () => actionCard(page, 'plan').hover(), {
      plays: [{ cites: '§5.15 action cards lift −3px, 120ms spring', match: toward(transition('transform', 'ix-way'), /translateY\(-3px\)/), duration: 120, curve: SPRING }],
    });
    await moment(page, 'Plan a night', () => actionCard(page, 'plan').click(), {
      plays: [
        { cites: '§5.6 FLIP from the action card’s rect (translate + scale), .5→1, 195ms spring', match: web('ix-conversation:draft'), duration: 195, curve: SPRING, fromTransform: /^translate\(.+\) scale\(/, toTransform: 'none', opacities: ['0.5', '1'], atMost: 1 },
        { cites: '§5.6 the welcome crossfades out, 90ms', match: web('ix-conversation:welcome-out'), duration: 90, curve: ANY, opacities: ['1', '0'], atMost: 1 },
      ],
    });
  });

  test('§5.7 joining: the yours layer fades in, your face flies from the toolbar avatar, the rest waits until 45%', async ({ page }, info) => {
    const h = await open(page, info);
    await h.step('arrive');
    await rest(page, 'Jeremy is here');
    await later(h, '21:45:00');
    await moment(page, 'Join', () => roomCard(page).getByTestId('ix-card-join').click(), {
      plays: [
        { cites: '§5.7 the yours layer fades in, 120ms ease', match: (r) => transition('opacity', 'ix-room-card__layer--yours')(r) && r.opacities.at(-1) === '1', duration: 120, curve: EASE },
        { cites: '§5.7 your row flies from the toolbar avatar: translate + scale, 225ms spring', match: webOn('ix-card:fly', 'ix-card-row__face'), duration: 225, curve: SPRING, fromTransform: /^translate\(.+\) scale\(/, toTransform: 'none', atMost: 1 },
        { cites: '§5.7 the card’s new content holds at 0 until 45%, then fades in', match: web('ix-card:fly-hold'), duration: 225, curve: ANY, opacities: ['0', '0', '1'] },
      ],
    });
    const records = await describeMoment(page);
    for (const hold of records.filter(web('ix-card:fly-hold'))) expect(hold.offsets, '§5.7 "holds at opacity 0 until 45%"').toEqual([0, 0.45, 1]);
  });

  test('§5.8/5.9 the call grows out of the card and back; theater moves to the window', async ({ page }, info) => {
    const h = await open(page, info);
    await h.step('arrive');
    await h.step('join');
    await rest(page, 'joined');
    await moment(page, 'Open call', () => roomCard(page, 'yours').getByTestId('ix-card-open-call').click(), {
      plays: [
        { cites: '§5.8 the surface grows out of the card: translate + non-uniform scale, .3→1, 185ms spring', match: web('ix-call:open'), duration: 185, curve: SPRING, fromTransform: /^translate\(.+\) scale\(.+, .+\)$/, toTransform: 'none', opacities: ['0.3', '1'], atMost: 1 },
        { cites: '§5.8 the tiles and controls are a counter-layer that fades in from 40%', match: web('ix-call:open-content'), duration: 185, curve: ANY, moves: ['opacity'], atMost: 1 },
        { cites: '§5.8 the wide control’s label crossfades, 60ms', match: (r) => r.kind === 'transition' && r.id === 'opacity' && r.duration === 60 && /span/.test(r.target), duration: 60, curve: ANY, atLeast: 2 },
      ],
    });
    const content = (await describeMoment(page)).find(web('ix-call:open-content'));
    const holdUntil = content ? content.opacityOffsets[content.opacities.lastIndexOf('0')] : -1;
    expect(holdUntil, '§5.8 the counter-layer holds at 0 until 40%, then fades in').toBeCloseTo(0.4, 2);
    const wholeBy = content ? content.opacityOffsets[content.opacities.indexOf('1')] : -1;
    expect(wholeBy, 'IX-18: … and is whole by 75%, so the call is drawn when the surface arrives (as the prototype)').toBeCloseTo(0.75, 2);
    await moment(page, 'Theater (T)', () => page.keyboard.press('t'), {
      plays: [
        { cites: '§5.9 the surface FLIPs from main’s inset to the window’s, 185ms spring', match: web('ix-call:theater'), duration: 185, curve: SPRING, fromTransform: /^translate\(/, toTransform: 'none', atMost: 1 },
        { cites: '§5.9 the sidebar dims to .4 beneath, 185ms spring', match: (r) => transition('opacity', 'ix-side')(r) && r.opacities.at(-1) === '0.4', duration: 185, curve: SPRING },
      ],
    });
    await moment(page, 'Theater off', () => page.keyboard.press('t'), {
      plays: [
        { cites: '§5.9 reverse the same', match: web('ix-call:theater'), duration: 185, curve: SPRING },
        { cites: '§5.9 the sidebar comes back to 1', match: (r) => transition('opacity', 'ix-side')(r) && r.opacities.at(-1) === '1', duration: 185, curve: SPRING },
      ],
    });
    await moment(page, 'Back to chat', () => page.getByTestId('ix-call-back').click(), {
      plays: [{ cites: '§5.8 back into the card, 135ms spring, then hidden', match: web('ix-call:close'), duration: 135, curve: SPRING, toTransform: /^translate\(.+\) scale\(/, atMost: 1 }],
    });
    await expect(page.locator('.ix-call')).toHaveCount(0);
  });

  test('§5.10 a message arrives from someone: it pops from the avatar side and what was there makes room', async ({ page }, info) => {
    const h = await open(page, info);
    await h.step('arrive');
    await rest(page, 'arrived');
    await later(h, '21:46:00');
    await moment(page, 'Jeremy says something', () => h.step('message', { channel: 'fuelGeneral', who: 'jeremy', text: 'you coming?' }), {
      plays: [
        { cites: '§5.10 the new bubble from translateY(14px) scale(.96), opacity 0, 165ms spring', match: web('ix-timeline:arrive'), duration: 165, curve: SPRING, fromTransform: 'translateY(14px) scale(0.96)', toTransform: 'none', opacities: ['0', '1'], atMost: 1 },
        { cites: '§5.10 earlier content FLIPs up (it was at the bottom)', match: web('ix-timeline:make-room'), duration: 165, curve: SPRING, moves: ['transform'] },
      ],
    });
  });

  test('§5.11 the send flight is not this gate’s to clamp: it still flies its 185ms arc', async ({ page }, info) => {
    const h = await open(page, info);
    await h.step('arrive');
    await rest(page, 'arrived');
    await composerInput(page).click();
    await page.keyboard.type('count me in');
    await rest(page, 'typed');
    await markMoment(page);
    await page.keyboard.press('Enter');
    await rest(page, 'sent');
    const flight = (await describeMoment(page)).filter((r) => r.kind === 'web' && r.id === 'data-motion-recipe:send-flight');
    expect(flight.length, 'the flight played').toBeGreaterThan(0);
    for (const record of flight.filter((r) => r.properties.includes('transform'))) expect(record.duration, 'M1: 185ms').toBe(185);
    const travel = Math.max(
      ...flight.flatMap((r) => r.transforms.map((t) => Math.max(...[...t.matchAll(/-?\d+(?:\.\d+)?px/g)].map((m) => Math.abs(Number.parseFloat(m[0])))))),
    );
    expect(travel, 'M1: never clamped to the quiet system’s 8px').toBeGreaterThan(40);
  });

  test('§5.12/5.13 the message box opens in three slices, the feed follows, the send control turns cream', async ({ page }, info) => {
    await open(page, info);
    await moment(page, 'the box opens', () => composerInput(page).click(), {
      plays: [
        { cites: '§5.12 the top cap translates up 46px, 150ms spring', match: webOn('ix-composer:shape:top', 'slice--top'), duration: 150, curve: SPRING, fromTransform: 'translateY(46px)', toTransform: 'none' },
        { cites: '§5.12 the middle scales in Y from 0 to 1, 150ms spring', match: webOn('ix-composer:shape:mid', 'slice--mid'), duration: 150, curve: SPRING, fromTransform: /^scaleY\(/, toTransform: 'none' },
        { cites: '§5.12 the tools row: opacity 90ms after 25ms', match: (r) => transition('opacity', 'ix-composer__tools')(r) && r.opacities.at(-1) === '1', duration: 90, curve: ANY, delay: 25 },
        { cites: '§5.12 the tools row: from translateY(6px), 135ms spring', match: toward(transition('transform', 'ix-composer__tools'), /^none$/), duration: 135, curve: SPRING, fromTransform: 'translateY(6px)' },
        { cites: '§5.12 the feed above FLIPs from its old position, 150ms spring', match: web('ix-conversation:feed'), duration: 150, curve: SPRING, moves: ['transform'] },
      ],
    });
    await moment(page, 'typing', () => page.keyboard.type('hey'), {
      plays: [{ cites: '§5.13 send: quiet → cream, a 60ms color transition', match: transition('background-color', 'ix-composer__send'), duration: 60, curve: ANY }],
    });
    await moment(page, 'the box closes', async () => {
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.locator('.ix-main').click({ position: { x: 600, y: 300 } });
    }, {
      plays: [
        { cites: '§5.12 closing reverses in 105ms', match: webOn('ix-composer:shape:top', 'slice--top'), duration: 105, curve: SPRING, fromTransform: 'translateY(-46px)' },
        { cites: '§5.12 the feed follows, 105ms', match: web('ix-conversation:feed'), duration: 105, curve: SPRING },
      ],
    });
  });

  test('§5.14 the title folds with the scroll, and the toolbar fills', async ({ page }, info) => {
    const h = await open(page, info);
    await h.step('arrive');
    await h.step('crowd');
    await h.step('busy', { pace: 0 });
    await rest(page, 'busy');
    await scrollConversation(page, 0);
    await rest(page, 'at the top');
    const records = await moment(page, 'scrolled past 40px', () => scrollConversation(page, 120), {
      plays: [
        { cites: '§5.14 the folded title enters: opacity 75ms', match: (r) => transition('opacity', 'ix-toolbar__title')(r) && r.opacities.at(-1) === '1', duration: 75, curve: ANY },
        { cites: '§5.14 … and from translateY(6px), 105ms spring', match: toward(transition('transform', 'ix-toolbar__title'), /^none$/), duration: 105, curve: SPRING, fromTransform: 'translateY(6px)' },
        { cites: '§5.14 the toolbar background appears, 90ms (color)', match: transition('background-color', 'ix-toolbar'), duration: 90, curve: ANY },
      ],
    });
    // Scroll-linked, no timer: the large title itself never animates.
    expect(records.filter((r) => r.target.includes('ix-large-title')).map(describe)).toEqual([]);
    // Where the scroll landed (the scroller may end short of 120 with other fonts): t = min(1, scrollTop / 60).
    const fold = await page.locator('.ix-timeline__header .ix-large-title').evaluate((el) => {
      const scroller = el.closest('.ix-timeline__scroller') as HTMLElement;
      return { top: scroller.scrollTop, scale: Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? 1), opacity: Number(el.style.opacity || 1) };
    });
    const t = Math.min(1, fold.top / 60);
    expect(fold.top, 'scrolled past the fold point (40px)').toBeGreaterThan(40);
    expect(fold.scale, '§5.14 scale(1 − .1t)').toBeCloseTo(1 - 0.1 * t, 3);
    expect(fold.opacity, '§5.14 opacity 1 − .9t').toBeCloseTo(1 - 0.9 * t, 3);
  });

  test('§5.15 hover lifts: the dock 2px, rows one shade lighter in color', async ({ page }, info) => {
    await open(page, info);
    await moment(page, 'hovering a dock item', () => dockItem(page, 'gameNight').hover(), {
      plays: [{ cites: '§5.15 dock items −2px, 105ms spring', match: toward(transition('transform', 'ix-dock__item'), /translateY\(-2px\)/), duration: 105, curve: SPRING }],
    });
    await moment(page, 'hovering a channel row', () => channelRow(page, 'fuelClips').hover(), {
      plays: [{ cites: '§5.15 rows: background one step lighter, 40ms ease (color only)', match: transition('background-color', 'ix-ch'), duration: 40, curve: EASE }],
    });
  });

  test('§5.16 Bring your people says "Link copied" with a 60ms crossfade, and back after 2s', async ({ page, context }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, info);
    await page.route(`**/api/v1/channels/${CH.fuelGeneral}/invites`, (route) =>
      json(route, { code: 'fuelfuel', channel_id: CH.fuelGeneral, guild_id: GUILD.fuel.id, created_at: '2026-10-01T00:00:00Z', inviter_id: ME.id, max_age: 0, max_uses: 0, uses: 0 }, 201));
    await page.route(`**/api/v1/guilds/${GUILD.fuel.id}/invites`, (route) => json(route, { error: 'forbidden' }, 403));
    await page.route('**/api/v1/instance/share-address', (route) => json(route, { url: 'https://paracord.example', reach: 'internet' }));
    await moment(page, 'copy', async () => {
      await actionCard(page, 'invite').click();
      await park(page);
      await page.waitForTimeout(2_400);
    }, {
      plays: [{ cites: '§5.16 the label crossfades (opacity), 60ms, there and back', match: (r) => r.kind === 'transition' && r.id === 'opacity' && /ix-way__[ab]/.test(r.target), duration: 60, curve: ANY, atLeast: 4 }],
    });
  });

  test('§5.17 sheets slide in from main’s right edge; menus scale from their anchor', async ({ page }, info) => {
    await open(page, info);
    await moment(page, 'the search sheet opens', () => page.getByRole('button', { name: 'Search messages' }).click(), {
      plays: [{ cites: '§5.17 sheets: translateX(24px), opacity 0 → none, 115ms spring', match: cssAnimation('ix-sheet-in'), duration: 115, curve: SPRING, fromTransform: /translate3d\(24px, 0px, 0px\)|translateX\(24px\)/, toTransform: 'none', opacities: ['0', '1'] }],
    });
    await moment(page, 'the search sheet closes', () => page.keyboard.press('Escape'), {
      plays: [{ cites: '§5.17 out 75ms ease', match: cssAnimation('ix-sheet-out'), duration: 75, curve: EASE }],
    });
    await moment(page, 'the server menu opens', () => page.getByRole('button', { name: 'Server options' }).click(), {
      plays: [{ cites: '§5.17 menus: scale(.97) + fade from their anchor, 55ms ease', match: cssAnimation('ix-pop-in'), duration: 55, curve: EASE, fromTransform: 'scale(0.97)', opacities: ['0', '1'] }],
    });
    await moment(page, 'the server menu closes', () => page.keyboard.press('Escape'), {
      plays: [{ cites: '§5.17 menus out 40ms', match: cssAnimation('ix-pop-out'), duration: 40, curve: ANY }],
    });
  });

  test('§5.18 a toast drops in under the toolbar and leaves after 4s', async ({ page }, info) => {
    await open(page, info);
    await moment(page, 'a toast', async () => {
      await page.evaluate(async () => {
        const toasts = (await import('/src/stores/toastStore.ts' as string)) as { toast: { success(message: string): void } };
        toasts.toast.success('Saved');
      });
      await page.waitForTimeout(4_600);
    }, {
      plays: [
        { cites: '§5.18 from translateY(−8px) + fade, 90ms spring', match: cssAnimation('pc-toast-in'), duration: 90, curve: SPRING, fromTransform: /translate3d\(0px, -8px, 0px\)|translateY\(-8px\)/, opacities: ['0'] },
        { cites: '§5.18 out 60ms', match: cssAnimation('pc-toast-out'), duration: 60, curve: ANY },
      ],
    });
  });

  test('§5.19/§4.4 the talking ring fades, and the waveform runs only while someone talks', async ({ page }, info) => {
    const h = await open(page, info);
    await h.step(voiceJoin, { who: 'jeremy', room: 'fuelRoomGeneral' });
    await rest(page, 'Jeremy is in General');
    await moment(page, 'Jeremy starts talking', () => h.step(speak, { who: 'jeremy', room: 'fuelRoomGeneral', speaking: true }), {
      plays: [{ cites: '§5.19 the ring: opacity 150ms in', match: (r) => transition('opacity', 'ix-card-row__ring')(r) && r.opacities.at(-1) === '1', duration: 150, curve: ANY }],
    });
    expect((await runningNow(page, { talking: true })).length, '§4.4 the waveform runs while he talks').toBeGreaterThan(0);
    await moment(page, 'Jeremy stops', () => h.step(speak, { who: 'jeremy', room: 'fuelRoomGeneral', speaking: false }), {
      plays: [{ cites: '§5.19 the ring: 300ms out', match: (r) => transition('opacity', 'ix-card-row__ring')(r) && r.opacities.at(-1) === '0', duration: 300, curve: ANY }],
    }, { strict: true });
    // §1.2: nobody talks, so nothing at all moves (the waveform is gone, not paused).
    expect(await runningNow(page, { talking: true })).toEqual([]);
    // §10: a share starting is said in words.
    await h.step(share, { who: 'jeremy', room: 'fuelRoomGeneral' });
    await expect(page.getByTestId('ix-announcer')).toContainText('Jeremy started sharing');
  });

  test('§5.20 a category collapses: its rows fade, the rest FLIPs up, the chevron turns', async ({ page }, info) => {
    await open(page, info);
    await page.evaluate(
      async ({ guildId, clips, plans }) => {
        const channels = (await import('/src/stores/channelStore.ts' as string)) as any;
        const guilds = (await import('/src/stores/guildStore.ts' as string)) as any;
        const guild = guilds.useGuildStore.getState().guilds.find((entry: any) => entry.id === guildId);
        const store = channels.useChannelStore;
        const existing = store.getState().channelsByGuild[guild.key] as any[];
        const category = { id: '999000000000000001', type: 4, guild_id: guildId, name: 'Planning', position: 1, nsfw: false, created_at: new Date().toISOString() };
        store.getState().addChannel(category, guild.scope);
        for (const id of [clips, plans]) store.getState().updateChannel({ ...existing.find((entry) => entry.id === id), parent_id: category.id }, guild.scope);
      },
      { guildId: GUILD.fuel.id, clips: CH.fuelClips, plans: CH.fuelPlans },
    );
    await rest(page, 'a category');
    const fold = page.getByRole('button', { name: 'Planning', exact: true });
    await moment(page, 'the category closes', async () => {
      await fold.click();
      await park(page);
    }, {
      plays: [
        { cites: '§5.20 its rows fade, 45ms', match: web('ix-collapse:fade'), duration: 45, curve: ANY, moves: ['opacity'] },
        { cites: '§5.20 the rest of the sidebar FLIPs up, 135ms spring', match: web('ix-collapse:move'), duration: 135, curve: SPRING, moves: ['transform'] },
        { cites: '§5.20 the chevron rotates, 60ms', match: transition('transform', 'ix-sb__chev'), duration: 60, curve: ANY },
      ],
    });
  });
});

test.describe('reduced motion (index-spec §5: every move a 65ms crossfade; no pings, no lifts; the waveform still)', () => {
  test('moves fade in place, pings and lifts are gone, the waveform is still', async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const h = await open(page, info);
    const fadesOnly = (label: string, records: MotionRecord[], named: string[]) => {
      for (const record of records) {
        expect(record.transforms.filter((t) => t !== 'none'), `${label}: nothing travels (${describe(record)})`).toEqual([]);
        if (record.properties.every((p) => COLORS.has(p))) continue;
        expect(record.duration ?? Infinity, `${label}: ${describe(record)} is a fade of at most ${REDUCED_MS}ms`).toBeLessThanOrEqual(REDUCED_MS);
      }
      for (const id of named) {
        const played = records.filter(web(id));
        expect(played.length, `${label}: ${id} crossfades`).toBeGreaterThan(0);
        for (const record of played) {
          expect(record.duration, `${label}: ${id} is ${REDUCED_MS}ms`).toBe(REDUCED_MS);
          expect(record.properties, `${label}: ${id} is opacity only`).toEqual(['opacity']);
        }
      }
    };
    const run = async (label: string, act: () => Promise<unknown>, named: string[], absent: string[] = []) => {
      await markMoment(page);
      await act();
      await rest(page, label);
      const records = await describeMoment(page);
      expectMoment(label, records, { plays: [], absent: absent.map((id) => ({ cites: `${id} is not played under reduced motion`, match: web(id) })) });
      fadesOnly(label, records, named);
    };
    await run('switch place', () => dockItem(page, 'gameNight').click(), ['ix-pane:in', 'ix-main:title', 'ix-main:feed']);
    await park(page);
    await run('switch channel', () => channelRow(page, 'gnLfg').click(), ['ix-select:fade', 'ix-main:title', 'ix-main:feed']);
    await run('back to Fuel', () => dockItem(page, 'fuel').click(), ['ix-pane:in']);
    await park(page);
    await run('a room goes live', () => h.step(voiceJoin, { who: 'jeremy', room: 'fuelRoomGeneral' }), ['ix-card:card-in']);
    await run('another server goes live: no ping', () => h.step(voiceJoin, { who: 'brendan', room: 'bcRoomWorkshop' }), [], ['ix-dock:ping']);
    await run('a lift is gone', () => dockItem(page, 'gameNight').hover(), []);
    await park(page);
    await run('join', () => roomCard(page).getByTestId('ix-card-join').click(), ['ix-card:fly']);
    await run('open call', () => roomCard(page, 'yours').getByTestId('ix-card-open-call').click(), ['ix-call:open']);
    await run('back to chat', () => page.getByTestId('ix-call-back').click(), ['ix-call:close']);
    await later(h, '21:46:00');
    await run('a message arrives', () => h.step('message', { channel: 'fuelGeneral', who: 'jeremy', text: 'you coming?' }), ['ix-timeline:arrive']);
    // CSS moments fade too (the app-wide switch would otherwise snap them).
    await markMoment(page);
    await page.getByRole('button', { name: 'Search messages' }).click();
    await rest(page, 'reduced: a sheet');
    const sheet = (await describeMoment(page)).filter(cssAnimation('ix-fade-in'));
    expect(sheet.map((r) => [r.duration, r.properties.join(',')]), 'a sheet crossfades in 65ms').toEqual([[REDUCED_MS, 'opacity']]);
    await page.keyboard.press('Escape');
    await rest(page, 'reduced: the sheet closed');
    await markMoment(page);
    await page.getByRole('button', { name: 'Server options' }).click();
    await rest(page, 'reduced: a menu');
    const menu = (await describeMoment(page)).filter(cssAnimation('ix-fade-in'));
    expect(menu.map((r) => [r.duration, r.properties.join(',')]), 'a menu crossfades in 65ms').toEqual([[REDUCED_MS, 'opacity']]);
    await page.keyboard.press('Escape');
    // The waveform is still: talking draws it, but nothing runs.
    await h.step(speak, { who: 'jeremy', room: 'fuelRoomGeneral', speaking: true });
    await page.waitForTimeout(600);
    expect(await runningNow(page, { talking: true }), 'the waveform is still').toEqual([]);
  });
});

test.describe('the gate catches what it guards', () => {
  test('a moment given a height or box-shadow animation fails the gate, as does a drifted duration', async ({ page }, info) => {
    await open(page, info, (h) => h.routes.channel('gnLounge'));
    await markMoment(page);
    await channelRow(page, 'gnLfg').click();
    // Someone "improves" the glide: a height animation beside it, and a shadow transition on a row.
    await page.evaluate(() => {
      const selection = document.querySelector<HTMLElement>('.ix-sel');
      const grow = selection?.animate([{ height: '51px' }, { height: '60px' }], { duration: 135, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
      if (grow) grow.id = 'ix-select:glide';
      const row = document.querySelector<HTMLElement>('[data-testid="ix-channel-row"]');
      if (row) {
        row.style.transition = 'box-shadow 135ms';
        row.style.boxShadow = '0 0 0 4px red';
      }
    });
    await page.waitForTimeout(1_200);
    const records = await describeMoment(page);
    const glide = { plays: [{ cites: '§5.2 glide', match: (r: MotionRecord) => web('ix-select:glide')(r) && r.properties.includes('transform'), duration: 135, curve: SPRING }] };
    expect(() => expectMoment('self-test: height', records, glide)).toThrow(/height/);
    expect(() => expectMoment('self-test: box-shadow', records, glide)).toThrow(/boxShadow/);
    // And a duration that is not the spec's.
    const clean = records.filter((r) => r.properties.every((p) => LAW.has(p) || COLORS.has(p)));
    expect(() => expectMoment('self-test: duration', clean, { plays: [{ ...glide.plays[0], duration: 90 }] })).toThrow(/duration/);
    // The same record without the injected animations passes.
    expect(() => expectMoment('self-test: clean', clean, glide)).not.toThrow();
  });
});
