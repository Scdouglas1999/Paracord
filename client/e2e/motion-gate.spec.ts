import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  fakeMedia,
  GENERAL,
  installMotionMocks,
  readMotionConstants,
  type MotionConstants,
} from './fixtures/motionFixture';

/**
 * The Glass motion gate (docs/glass-spec.md §9; docs/design/glass-plan.md §5.3).
 *
 * "A frame over 32 ms fails": every Glass moment is measured, not judged by eye.
 * A `requestAnimationFrame` sampler runs across the moment and records every
 * frame interval AND every animation the document had in flight (CSS
 * transitions, CSS animations and Web Animations alike), so a regression names
 * the frame and the recipe.
 *
 *   hover          a places row and a glass button step one wash lighter; press one darker
 *   pill           the faces open it (and close it) on the spring, on transform
 *   pill -> stage  Watch grows the stage out of the pill; Stop watching shrinks it back
 *   theater (T)    side by side <-> theater; browse (S), beside the stream and in theater
 *   room           a server switch crossfades the room: two canvases' opacity
 *   phone          places <-> conversation, the phone's two screens
 *   shared element `lib/motion/sharedElement.ts`: View Transitions and FLIP, one choreography
 *   reduced        every move as a 150ms crossfade, the spring nothing, the loops stopped
 *
 * THE NUMBERS. No duration is the gate's own. Each is the constant of the
 * package that owns the moment, read from the running app (`readMotionConstants`),
 * and the gate first holds each constant to what the spec says (the first case):
 * the pill's spring 550ms (§5), a layout move 650ms (§6, §9: "600-650ms"), hover
 * 120ms (§9), the room 1.2s (§4), reduced motion 150ms (§9). An animation that
 * IS a moment must run exactly its constant; anything else in the window either
 * belongs to another moment (held to that one's constant) or may not run longer
 * than this moment does.
 *
 * THE FRAME BUDGET is 32ms, given by the brief of this gate and used by the gate
 * before it. Frames are only judged while an animation is in flight (the click
 * and React's commit of the new state come before the first animated frame and
 * are held to a long-task ceiling instead). What the stage's moves cost today is
 * over the budget by a frame or two, and is named in `KNOWN`, so it cannot grow
 * without this failing; the hover, the pill, browse and the phone's slide are at
 * zero.
 *
 * THE LAW. Only `transform` and `opacity` move, plus color on what is pressed,
 * plus `border-radius` where §9 says "position, size and radius animate
 * together" (a box that grows into another: the pill and the panes). Any other
 * animated property, in any moment, fails the gate by name (`motion-lint.mjs`
 * keeps the same rule in the source).
 *
 * WHICH ENGINE. The Glass layout moves are ONE engine on every platform: Web
 * Animations on transform (`lib/motion/sharedElement.ts`, `playMorph`), so the
 * gate asserts that a layout move never starts a View Transition
 * (docs/design/glass-g15-checkpoint.md, "Why not View Transitions"). The other
 * half of that file, `transitionWith` (View Transitions where the webview has
 * them, FLIP elsewhere), still carries "walk into a room" from the timeline's
 * event line and a server's overview, and is gated on its own demo.
 *
 * NOT A MOMENT OF THIS GATE: the send flight (docs/glass-spec.md §9), a protected
 * signature gesture exempt from the 8px / 500ms / no-overshoot ceilings of the
 * quiet motion system. This gate never sends a message; the flight is filmed and
 * measured on its own (e2e/glass-send.spec.ts, `npx playwright test -c
 * e2e/glass-send.config.ts`), and its constants are pinned in sendFlight.test.tsx.
 *
 * Opt in:  PARACORD_E2E_MOTION=1 npx playwright test   (`npm run test:motion`)
 * It is gated out of the default mocked smoke so CI stays fast.
 */

/** A frame with an animation in flight over this fails. The gate's own (30 fps), not the spec's. */
const FRAME_BUDGET_MS = 32;

/**
 * The longest any single frame of a moment may be, the click and React's commit
 * included: a frame that long is a hang, not a missed beat (RAIL's 100ms).
 * A moment that mounts a whole surface says so, and why, where it raises it.
 */
const COMMIT_FRAME_CEILING_MS = 100;

/**
 * CSS properties an animation may touch. `border-radius` is allowed only where
 * the moment says so (§9: "position, size and radius animate together").
 */
const LAW = new Set(['transform', 'opacity', 'transformOrigin', 'translate', 'scale', 'rotate']);
const COLORS = new Set(['backgroundColor', 'color', 'borderColor', 'outlineColor', 'fill', 'stroke']);
const RADIUS = new Set([
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
]);
/** Bookkeeping in a keyframe, not a property. */
const KEYFRAME_META = new Set(['offset', 'computedOffset', 'easing', 'composite']);

/* ---- The sampler ------------------------------------------------------------- */

interface AnimationRecord {
  /** `CSSTransition`, `CSSAnimation`, or a Web Animation. */
  kind: 'transition' | 'animation' | 'web';
  /** A Web Animation's id (`glass-morph:stage`), a CSS animation's or transition's property. */
  id: string;
  /** Where it ran: `div.glass-place-row::before`. */
  target: string;
  /** Milliseconds, the active phase. `Infinity` for a loop (serialized as null). */
  duration: number | null;
  loops: boolean;
  /** Every CSS property any of its keyframes sets. */
  properties: string[];
  /** Each keyframe's transform, in order (empty when none sets one). */
  transforms: string[];
  /** Each keyframe's opacity, in order. */
  opacities: string[];
}

interface MomentSample {
  frames: Array<{ at: number; animating: boolean }>;
  records: AnimationRecord[];
}

/**
 * Run `act` with a frame sampler attached and report what the browser did.
 *
 * The sampler ignores animations with infinite iterations when it decides
 * whether the engine was animating: the talking waveform breathes on screen all
 * the time and would make every frame of every moment "animating". It still
 * RECORDS them (the reduced-motion case asserts there are none).
 */
async function measureMoment(page: Page, act: () => Promise<void>, settleMs = 1100): Promise<MomentSample> {
  await page.evaluate(() => {
    const bag = { frames: [] as Array<{ at: number; animating: boolean }>, records: [] as unknown[], running: true };
    (window as unknown as { __motionSample: typeof bag }).__motionSample = bag;
    const seen = new WeakSet<Animation>();
    const describe = (el: Element | null | undefined, pseudo: string | null | undefined) => {
      if (!el) return 'unknown';
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${pseudo ?? ''}`;
    };
    const tick = (now: number) => {
      let animating = false;
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null;
        const timing = effect?.getComputedTiming?.();
        if (!effect || !timing) continue;
        const loops = timing.iterations === Infinity;
        if (!loops && timing.progress !== null && timing.progress !== undefined && animation.playState === 'running') animating = true;
        if (seen.has(animation)) continue;
        seen.add(animation);
        const keyframes = (effect.getKeyframes?.() ?? []) as Keyframe[];
        const meta = ['offset', 'computedOffset', 'easing', 'composite'];
        const properties = new Set<string>();
        for (const keyframe of keyframes) for (const key of Object.keys(keyframe)) if (!meta.includes(key)) properties.add(key);
        const isTransition = typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition;
        const isCssAnimation = typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation;
        bag.records.push({
          kind: isTransition ? 'transition' : isCssAnimation ? 'animation' : 'web',
          id: isTransition
            ? (animation as CSSTransition).transitionProperty
            : isCssAnimation
              ? (animation as CSSAnimation).animationName
              : animation.id,
          target: describe(effect.target, (effect as KeyframeEffect & { pseudoElement?: string | null }).pseudoElement),
          duration: loops ? null : Number(timing.activeDuration) || 0,
          loops,
          properties: [...properties],
          transforms: keyframes.filter((k) => k.transform !== undefined).map((k) => String(k.transform)),
          opacities: keyframes.filter((k) => k.opacity !== undefined).map((k) => String(k.opacity)),
        });
      }
      bag.frames.push({ at: now, animating });
      if (bag.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await act();
  await page.waitForTimeout(settleMs);

  return page.evaluate(() => {
    const bag = (window as unknown as { __motionSample: { frames: MomentSample['frames']; records: MomentSample['records']; running: boolean } }).__motionSample;
    bag.running = false;
    return { frames: bag.frames, records: bag.records } as MomentSample;
  });
}

interface Frame {
  delta: number;
  /** When, in ms from the sampler's first frame. */
  at: number;
  /** Whether an animation was in flight when this interval started. */
  engineRunning: boolean;
}

/** Frame intervals, minus the first pair (the sampler's own warm-up). */
function intervals(sample: MomentSample): Frame[] {
  const origin = sample.frames[0]?.at ?? 0;
  const out: Frame[] = [];
  for (let i = 2; i < sample.frames.length; i += 1) {
    out.push({
      delta: sample.frames[i].at - sample.frames[i - 1].at,
      at: Math.round(sample.frames[i].at - origin),
      engineRunning: sample.frames[i - 1].animating,
    });
  }
  return out;
}

const describeFrame = (frame: Frame) =>
  `${frame.delta.toFixed(1)}ms at +${frame.at}ms (${frame.engineRunning ? 'an animation was in flight' : 'nothing in flight'})`;

function percentile(frames: Frame[], p: number): number {
  if (frames.length === 0) return 0;
  const sorted = frames.map((frame) => frame.delta).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/* ---- What a moment must be --------------------------------------------------- */

interface Expected {
  /** The animations that ARE this moment: which, and how long each runs. */
  plays: Array<{
    /** Matches a record's id (a Web Animation's id, a transition's property) and/or its target. */
    match: (record: AnimationRecord) => boolean;
    /** The constant, in ms, the moment is held to (the app's own). */
    duration: number;
    /** Why that number: the constant's name. */
    cites: string;
    /** At least this many (default 1). */
    atLeast?: number;
  }>;
  /** `border-radius` may animate (a box growing into another, §9). */
  radius?: boolean;
  /** Allow colors to animate (the hover step). */
  colors?: boolean;
  /** Longest any finite animation in the window may run, ms (default: the longest `plays`). */
  ceiling?: number;
  /**
   * Frames the moment may drop while an animation is in flight, named at the call site with
   * whose work they are (default 0). A frame is dropped when it is over FRAME_BUDGET_MS.
   */
  droppedFrames?: number;
  /**
   * The longest any single frame of the window may be (default COMMIT_FRAME_CEILING_MS). A moment
   * that mounts a whole surface says so, and why, where it raises it.
   */
  commitCeilingMs?: number;
  /**
   * Whether the frame rules apply at all (default true). Not for the View Transitions path: the browser
   * snapshots the whole viewport to run it, and on a runner with no GPU that costs frames the engine does
   * not spend. What must hold there is the choreography, the duration and the law.
   */
  frames?: boolean;
}

function report(label: string, sample: MomentSample) {
  const frames = intervals(sample);
  const animating = frames.filter((frame) => frame.engineRunning);
  const worst = animating.reduce((max, frame) => (frame.delta > max.delta ? frame : max), { delta: 0, at: 0, engineRunning: true });
  const worstOverall = frames.reduce((max, frame) => (frame.delta > max.delta ? frame : max), { delta: 0, at: 0, engineRunning: false });
  const finite = sample.records.filter((record) => !record.loops);
  const longest = finite.reduce((max, record) => Math.max(max, record.duration ?? 0), 0);
  // The numbers go in the run log on purpose: the checkpoint quotes them.
  console.log(
    `[motion-gate] ${label}: animating-frames=${animating.length}/${frames.length} `
    + `worst-animating=${worst.delta.toFixed(1)}ms@+${worst.at} worst-overall=${worstOverall.delta.toFixed(1)}ms@+${worstOverall.at} `
    + `dropped=${animating.filter((f) => f.delta > FRAME_BUDGET_MS).length} `
    + `p95=${percentile(animating, 95).toFixed(1)}ms longest=${longest}ms animations=${finite.length}`,
  );
  if (process.env.PARACORD_E2E_MOTION_VERBOSE) {
    for (const frame of frames.filter((f) => f.delta > FRAME_BUDGET_MS)) {
      console.log(`[motion-gate]   ${label}: frame ${describeFrame(frame)}`);
    }
    for (const record of sample.records.filter((r) => !r.loops)) {
      console.log(
        `[motion-gate]   ${label}: ${record.kind} ${record.id} @${record.target} ${record.loops ? 'loop' : `${record.duration}ms`} `
        + `[${record.properties.join(', ')}]`,
      );
    }
  }
  return { frames, animating, worst, worstOverall, finite, longest };
}

/**
 * Every budget a Glass moment has, applied to one measured moment: the frames,
 * the durations (each animation that IS the moment runs exactly the package's
 * constant), and the law (only what the spec lets animate did).
 */
function expectMoment(label: string, sample: MomentSample, expected: Expected) {
  const measured = report(label, sample);
  expect(measured.frames.length, `${label}: the sampler saw no frames`).toBeGreaterThan(10);
  expect(measured.animating.length, `${label}: nothing animated`).toBeGreaterThan(0);

  if (expected.frames !== false) {
  // Frames: every frame with an animation in flight is a frame, at most `droppedFrames` of which may miss
  // the budget (named at the call site, with whose work it is).
  const dropped = measured.animating.filter((frame) => frame.delta > FRAME_BUDGET_MS);
  expect(
    dropped.map(describeFrame),
    `${label}: more than ${expected.droppedFrames ?? 0} frame(s) over ${FRAME_BUDGET_MS}ms while an animation was in flight`,
  ).toHaveLength(Math.min(dropped.length, expected.droppedFrames ?? 0));
  const commitCeiling = expected.commitCeilingMs ?? COMMIT_FRAME_CEILING_MS;
  expect(
    measured.worstOverall.delta,
    `${label}: ${describeFrame(measured.worstOverall)} is a long task inside the moment (ceiling ${commitCeiling}ms)`,
  ).toBeLessThanOrEqual(commitCeiling);
  }

  // Durations: each animation that is the moment runs exactly the constant.
  let longestPlayed = 0;
  for (const play of expected.plays) {
    const matched = measured.finite.filter(play.match);
    expect(
      matched.length,
      `${label}: expected at least ${play.atLeast ?? 1} animation(s) for ${play.cites}; saw ${measured.finite.map((r) => `${r.kind}:${r.id}@${r.target}`).join(', ') || 'none'}`,
    ).toBeGreaterThanOrEqual(play.atLeast ?? 1);
    for (const record of matched) {
      expect(record.duration, `${label}: "${record.id}" on ${record.target} should run ${play.cites} = ${play.duration}ms`).toBe(play.duration);
    }
    longestPlayed = Math.max(longestPlayed, play.duration);
  }
  // What else was in the window: each neighbor is some other moment's own recipe, held to ITS constant
  // (a server switch starts the room's crossfade whatever moment it happens inside), and anything
  // else may not run longer than this moment does.
  const ceiling = expected.ceiling ?? longestPlayed;
  const strangers: string[] = [];
  for (const record of measured.finite) {
    if (expected.plays.some((play) => play.match(record)) || isHoverStep(record)) continue;
    const neighbor = NEIGHBORS().find((candidate) => candidate.match(record));
    if (neighbor) {
      expect(record.duration, `${label}: "${record.id}" on ${record.target} belongs to ${neighbor.owner}: ${neighbor.cites} = ${neighbor.duration}ms`).toBe(neighbor.duration);
    } else if ((record.duration ?? 0) > ceiling) {
      strangers.push(`${record.kind}:${record.id}@${record.target} ${record.duration}ms`);
    }
  }
  expect(strangers, `${label}: something runs longer than the moment's ${ceiling}ms`).toEqual([]);

  // The law. (The pointer is always somewhere: the hover step it causes on the
  // way, a color at `--glass-ms`, is a moment of its own and is gated above.)
  const illegal = new Set<string>();
  for (const record of sample.records) {
    if (isHoverStep(record)) continue;
    // The View Transitions path is the browser's own: its snapshot groups animate width and height
    // because that is how a user agent morphs a snapshot, and no source-level rule can reach them.
    // What the app asks of them (which element, how long) is held above.
    if (record.target.includes('::view-transition')) continue;
    for (const property of record.properties) {
      if (KEYFRAME_META.has(property) || LAW.has(property)) continue;
      if (expected.colors && COLORS.has(property)) continue;
      if (expected.radius && RADIUS.has(property)) continue;
      illegal.add(`${property} (${record.kind}:${record.id}@${record.target}, ${record.duration}ms)`);
    }
  }
  expect([...illegal], `${label}: only transform and opacity move${expected.radius ? ' (and border-radius, for a box that grows)' : ''}${expected.colors ? ' (and color, on what is pressed)' : ''}`).toEqual([]);
  return measured;
}

/* ---- Helpers ------------------------------------------------------------------- */

/**
 * Animations that belong to another moment and may share a window with this one.
 * Each is held to its owner's constant wherever it turns up.
 */
const NEIGHBORS = () => [
  {
    owner: 'the room',
    cites: '--glass-ms-room',
    duration: constants.glassMsRoom,
    // Opening a stage or switching a server changes what lights the room: its two canvases crossfade.
    match: (r: AnimationRecord) => r.kind === 'transition' && r.id === 'opacity' && r.target.includes('glass-room-backdrop__layer'),
  },
  {
    owner: 'the content swap',
    cites: '--duration-slow',
    duration: constants.durationSlow,
    // A route change (picking a channel) crossfades the page in with a 4px rise.
    match: (r: AnimationRecord) => r.kind === 'web' && r.id === 'data-motion-recipe:content',
  },
];

/**
 * The step a pointer causes on whatever it crosses: a CSS transition of color, opacity or transform
 * that takes at most `--glass-ms` (a hover that is left again before its 120ms are up reverses in
 * less). It is its own moment, gated above, and may show up inside any other.
 */
const isHoverStep = (record: AnimationRecord) =>
  record.kind === 'transition'
  && record.duration !== null
  && record.duration <= constants.glassMs
  && record.properties.length > 0
  && record.properties.every((p) => COLORS.has(p) || p === 'opacity' || p === 'transform');

const pill = (page: Page) => page.getByRole('region', { name: /live voice channel|voice call/ });
const stagePane = (page: Page) => page.getByRole('region', { name: 'Stage' });

/** Every move's clones and shield are gone, and nothing of it is still playing. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.getAnimations().filter((a) => a.id.startsWith('glass-morph:') && a.playState === 'running').length
          + document.querySelectorAll('.glass-morph > *').length,
      ),
    )
    .toBe(0);
  await page.waitForTimeout(250);
}

/**
 * The mocked server refuses read-state acks ("Failed to save read position"), and
 * that toast is the harness's, not the moment's: it would enter and leave inside
 * the window being measured.
 */
async function clearToasts(page: Page) {
  await page.evaluate(async () => {
    const toasts = (await import('/src/stores/toastStore.ts' as string)) as { useToastStore: { setState: (s: unknown) => void } };
    toasts.useToastStore.setState({ toasts: [] });
  });
}

/** The room has found its light and everything has been still for a moment. */
async function quiet(page: Page) {
  await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-phase', 'lit', { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await clearToasts(page);
}

async function open(page: Page, size: { width: number; height: number } = { width: 1440, height: 900 }) {
  await page.setViewportSize(size);
  await installMotionMocks(page);
  await page.goto(GENERAL);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(pill(page)).toBeVisible();
  await quiet(page);
  constants = await readMotionConstants(page);
}

/** Go to a server, let the room settle on it, and come back to where you were. */
async function visitAndReturn(page: Page, there: Locator, back: Locator) {
  await there.click();
  await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-phase', 'lit', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await back.click();
  await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-source', /^stream-/);
  await page.waitForTimeout(2500);
  await parkPointer(page);
}

async function watchFromPill(page: Page) {
  await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
  await expect(stagePane(page)).toBeVisible();
  await expect(page.locator('.glass-frame__stage .glass-stage__stream[data-picture="true"]')).toBeVisible();
  await settled(page);
  await clearToasts(page);
}

/** The pointer goes somewhere it hovers nothing. */
async function parkPointer(page: Page) {
  const size = page.viewportSize();
  if (size) await page.mouse.move(size.width - 3, size.height - 3);
  await page.waitForTimeout(250);
}

const isMorph = (record: AnimationRecord) => record.kind === 'web' && record.id.startsWith('glass-morph:');
const morphNamed = (name: string) => (record: AnimationRecord) => record.kind === 'web' && record.id === `glass-morph:${name}`;
const transitionOf = (property: string, within?: string) => (record: AnimationRecord) =>
  record.kind === 'transition' && record.id === property && (within === undefined || record.target.includes(within));

/** A layout move never starts a View Transition: the Glass moves are one engine (playMorph). */
async function countViewTransitions(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const doc = document as unknown as { startViewTransition?: (...args: unknown[]) => unknown };
    const w = window as unknown as { __viewTransitions: number };
    w.__viewTransitions = 0;
    const original = doc.startViewTransition?.bind(document);
    doc.startViewTransition = (...args: unknown[]) => {
      w.__viewTransitions += 1;
      return original?.(...args);
    };
  });
  return () => page.evaluate(() => (window as unknown as { __viewTransitions: number }).__viewTransitions);
}

/**
 * What the stage's moves cost today, in a dev build on a software-rendered runner, named so it cannot
 * grow unnoticed (docs/design/glass-g22-checkpoint.md hands it to WP-G23).
 *
 * The moves themselves are transform and opacity and run clean: the hover, the pill, browse and the
 * phone's slide hold every frame at 20ms or under. The stage's moves (open, close, theater) and a server
 * switch each drop two or three frames (45 to 90ms) while React re-renders what the move changes around
 * them: the message rows and the message box for the conversation's new width, the other server's places
 * for a switch. The animation is not what is slow, and a production build is cheaper than this dev one.
 */
const KNOWN = {
  /** Frames over the budget while a stage move runs (seen: one to three). */
  stageMoves: { droppedFrames: 3 },
  /** The longest single frame when the click mounts the stage (seen: 65 to 134ms). */
  mountsStageMs: 150,
  /** A server switch (seen: two or three frames, the longest 65 to 90ms). */
  switchesServer: { droppedFrames: 3, commitCeilingMs: 150 },
};

/** Every duration below, read from the running app by `open` (they are the app's, not the gate's). */
let constants: MotionConstants;

test.describe('the Glass motion gate (§9)', () => {
  test('the constants are the spec\'s', async ({ page }) => {
    await open(page);
    // §9 and §4/§5/§6, read from the app: a constant that drifts out of the spec fails here,
    // before any moment is measured against it.
    expect(constants.glassMs, '--glass-ms: hover and press, "120ms ease-out" (§9)').toBe(120);
    expect(constants.PILL_SPRING_MS, 'PILL_SPRING_MS: "grows ... (spring, 550ms)" (§5)').toBe(550);
    expect(constants.STAGE_MOVE_MS, 'STAGE_MOVE_MS: "shared-element transition ... 650ms" (§6)').toBe(650);
    expect(constants.glassMsLayout, '--glass-ms-layout is the same move').toBe(constants.STAGE_MOVE_MS);
    expect(constants.STAGE_MOVE_MS, '"600-650ms spring" (§9)').toBeGreaterThanOrEqual(600);
    expect(constants.STAGE_MOVE_MS).toBeLessThanOrEqual(650);
    expect(constants.glassMsRoom, '--glass-ms-room: "switching servers crossfades over 1.2s" (§4)').toBe(1200);
    expect(constants.glassMsReduced, '--glass-ms-reduced: "150ms crossfades" (§9)').toBe(150);
    expect(constants.STAGE_CROSSFADE_MS).toBe(constants.glassMsReduced);
    expect(constants.PHONE_FADE_MS).toBe(constants.glassMsReduced);
    expect(constants.PILL_FADE_REDUCED_MS).toBe(constants.glassMsReduced);
    // The phone's slide is a navigation, not a scene change: its own number, shorter than a layout move.
    expect(constants.PHONE_SLIDE_MS, 'PHONE_SLIDE_MS (glass-g20): shorter than a layout move').toBeLessThan(constants.STAGE_MOVE_MS);
  });

  test('hover: a places row and a glass button step one wash lighter in 120ms, on color alone', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    const row = page.getByRole('navigation', { name: 'Channels' }).getByRole('link', { name: /Clips/ });
    await expect(row).toBeVisible();
    await parkPointer(page);

    const hover = await measureMoment(page, async () => {
      await row.hover();
    }, 500);
    expectMoment('hover (places row)', hover, {
      plays: [{ match: transitionOf('background-color', 'glass-place-row'), duration: constants.glassMs, cites: '--glass-ms' }],
      colors: true,
    });

    // Pressed, then dragged off before the button comes up: a press, not a click
    // (a click would open the channel, and its page would swap in under the next moment).
    const press = await measureMoment(page, async () => {
      await page.mouse.down();
    }, 500);
    await parkPointer(page);
    await page.mouse.up();
    expectMoment('press (places row)', press, {
      plays: [{ match: transitionOf('background-color', 'glass-place-row'), duration: constants.glassMs, cites: '--glass-ms' }],
      colors: true,
    });

    // A glass button (the pill's Listen) steps the same way.
    await parkPointer(page);
    const listen = pill(page).getByRole('button', { name: 'Listen in to Lounge' });
    const button = await measureMoment(page, async () => {
      await listen.hover();
    }, 500);
    expectMoment('hover (glass button)', button, {
      plays: [{ match: transitionOf('background-color', 'glass-btn'), duration: constants.glassMs, cites: '--glass-ms' }],
      colors: true,
    });
    await parkPointer(page);
  });

  test('pill: the faces open it and close it on the spring, on transform (and its radius)', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    const faces = pill(page).getByRole('button', { name: "Show who's in Lounge" });

    const opening = await measureMoment(page, async () => {
      await faces.click();
    });
    await expect(pill(page)).toHaveAttribute('data-phase', 'expanded');
    const opened = expectMoment('pill (open)', opening, {
      plays: [
        { match: (r) => r.id === 'glass-pill:surface', duration: constants.PILL_SPRING_MS, cites: 'PILL_SPRING_MS' },
        { match: (r) => r.id === 'glass-pill:glow', duration: constants.PILL_SPRING_MS, cites: 'PILL_SPRING_MS' },
      ],
      radius: true,
      // The roster and the words fade in beside the spring (CSS opacity, --pill-fade).
      ceiling: constants.PILL_SPRING_MS,
    });
    // The capsule's size and place is the spring on transform; its radius rides the same curve.
    const surface = opened.finite.find((r) => r.id === 'glass-pill:surface');
    expect(surface?.properties.sort(), 'the capsule animates transform and its radius only').toEqual(['borderRadius', 'transform']);

    const closing = await measureMoment(page, async () => {
      await faces.click();
    });
    await expect(pill(page)).toHaveAttribute('data-phase', 'compact');
    expectMoment('pill (close)', closing, {
      plays: [{ match: (r) => r.id === 'glass-pill:surface', duration: constants.PILL_SPRING_MS, cites: 'PILL_SPRING_MS' }],
      radius: true,
      ceiling: constants.PILL_SPRING_MS,
    });
  });

  test('pill -> stage: Watch grows the stage out of the pill in 650ms, and Stop watching shrinks it back', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    await fakeMedia(page, { joined: false, watchers: 1 });
    const viewTransitions = await countViewTransitions(page);

    const opening = await measureMoment(page, async () => {
      await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
    });
    await expect(stagePane(page)).toBeVisible();
    const opened = expectMoment('pill -> stage (Watch)', opening, {
      plays: [
        { match: morphNamed('stage'), duration: constants.STAGE_MOVE_MS, cites: 'STAGE_MOVE_MS' },
        { match: isMorph, duration: constants.STAGE_MOVE_MS, cites: 'STAGE_MOVE_MS', atLeast: 2 },
      ],
      radius: true,
      ...KNOWN.stageMoves,
      // The click mounts the whole stage (people, controls, the stream's canvases) before the
      // first animated frame: React's render of it, in a dev build, is the long frame.
      commitCeilingMs: KNOWN.mountsStageMs,
    });
    // The stage is the thing that grows, and it carries its radius with it.
    expect(opened.finite.find(morphNamed('stage'))?.properties).toContain('transform');
    expect(await viewTransitions(), 'a layout move is Web Animations; it never starts a View Transition').toBe(0);
    await settled(page);

    const closing = await measureMoment(page, async () => {
      await page.keyboard.press('Escape');
    });
    await expect(stagePane(page)).toHaveCount(0);
    expectMoment('stage -> pill (Stop watching)', closing, {
      plays: [{ match: isMorph, duration: constants.STAGE_MOVE_MS, cites: 'STAGE_MOVE_MS', atLeast: 2 }],
      radius: true,
      ...KNOWN.stageMoves,
    });
    expect(await viewTransitions()).toBe(0);
    // Stopping never leaves: the pill is back, and nothing of the move is left behind.
    await expect(pill(page)).toBeVisible();
    await settled(page);
  });

  test('theater (T): side by side and theater trade places in 650ms, stream scaled, never stretched', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    await fakeMedia(page, { joined: true, watchers: 2 });
    await watchFromPill(page);
    const viewTransitions = await countViewTransitions(page);

    const toTheater = await measureMoment(page, async () => {
      await page.keyboard.press('t');
    });
    await expect(page.locator('.glass-stage[data-mode="theater"]')).toBeVisible();
    const entered = expectMoment('theater (T)', toTheater, {
      plays: [{ match: isMorph, duration: constants.STAGE_MOVE_MS, cites: 'STAGE_MOVE_MS', atLeast: 2 }],
      radius: true,
      ...KNOWN.stageMoves,
    });
    // The stream travels with one uniform scale: no keyframe of its morph scales one axis only.
    const stream = entered.finite.find(morphNamed('stream'));
    expect(stream, 'the stream is one of the things that moves').toBeTruthy();
    for (const transform of stream?.transforms ?? []) {
      const scale = /scale\(([\d.e+-]+),\s*([\d.e+-]+)\)/.exec(transform);
      if (scale) expect(Math.abs(Number(scale[1]) - Number(scale[2])), `the stream stretched: ${transform}`).toBeLessThan(0.01);
    }
    await settled(page);

    const back = await measureMoment(page, async () => {
      await page.keyboard.press('t');
    });
    await expect(page.locator('.glass-stage[data-mode="side"]')).toBeVisible();
    expectMoment('theater (T, back)', back, {
      plays: [{ match: isMorph, duration: constants.STAGE_MOVE_MS, cites: 'STAGE_MOVE_MS', atLeast: 2 }],
      radius: true,
      ...KNOWN.stageMoves,
    });
    expect(await viewTransitions()).toBe(0);
    await settled(page);
  });

  test('browse (S): places slides back in beside the stream in 650ms, and Esc puts it away', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    await fakeMedia(page, { joined: false });
    await watchFromPill(page);

    const browsing = await measureMoment(page, async () => {
      await page.keyboard.press('s');
    });
    await expect(page.locator('.glass-frame__places')).toBeVisible();
    await expect(page.getByRole('main')).toHaveAttribute('data-away', 'true');
    expectMoment('browse (S)', browsing, {
      // The morph is the stage and places; the conversation steps aside on the CSS
      // transition of the same length (--glass-ms-layout), on transform and opacity.
      plays: [
        { match: isMorph, duration: constants.STAGE_MOVE_MS, cites: 'STAGE_MOVE_MS', atLeast: 1 },
        { match: (r) => r.kind === 'transition' && r.target.startsWith('main.'), duration: constants.glassMsLayout, cites: '--glass-ms-layout', atLeast: 2 },
      ],
      radius: true,
    });
    await settled(page);

    const away = await measureMoment(page, async () => {
      await page.keyboard.press('Escape');
    });
    await expect(page.locator('.glass-frame__places')).toHaveCount(0);
    expectMoment('browse (S, away)', away, {
      plays: [{ match: isMorph, duration: constants.STAGE_MOVE_MS, cites: 'STAGE_MOVE_MS', atLeast: 1 }],
      radius: true,
    });
    await settled(page);
  });

  test('browse in theater: places floats over the stream and the faces and controls move over', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    await fakeMedia(page, { joined: false });
    await watchFromPill(page);
    await page.keyboard.press('t');
    await settled(page);

    const browsing = await measureMoment(page, async () => {
      await page.keyboard.press('s');
    });
    await expect(page.locator('.glass-stage[data-mode="theater"][data-browse="true"]')).toBeVisible();
    expectMoment('browse in theater (S)', browsing, {
      plays: [{ match: isMorph, duration: constants.STAGE_MOVE_MS, cites: 'STAGE_MOVE_MS', atLeast: 1 }],
      radius: true,
    });
    await settled(page);
  });

  test('room: a server switch crossfades the two canvases over 1.2s, on opacity', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    const servers = page.getByRole('navigation', { name: 'Servers' });
    const basecamp = servers.getByRole('button', { name: /^Basecamp/ });
    await expect(basecamp).toBeVisible();
    // Visit Basecamp once and come back: its channels, previews and members are in the stores,
    // so what the window measures is the crossfade, not the first load of a server.
    await visitAndReturn(page, basecamp, servers.getByRole('button', { name: /^Game Night/ }));
    await clearToasts(page);

    // The room's own sample: both canvases' opacity, every frame, across the switch.
    await page.evaluate(() => {
      const bag = { samples: [] as Array<{ at: number; opacities: number[] }>, running: true, started: 0 };
      (window as unknown as { __roomFade: typeof bag }).__roomFade = bag;
      const tick = (now: number) => {
        if (!bag.started) bag.started = now;
        bag.samples.push({
          at: now - bag.started,
          opacities: [...document.querySelectorAll('.glass-room-backdrop__layer')].map((layer) => Number(getComputedStyle(layer).opacity)),
        });
        if (bag.running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const crossfade = await measureMoment(
      page,
      async () => {
        await basecamp.click();
      },
      constants.glassMsRoom + 900,
    );
    const fade = await page.evaluate(() => {
      const bag = (window as unknown as { __roomFade: { samples: Array<{ at: number; opacities: number[] }>; running: boolean } }).__roomFade;
      bag.running = false;
      return bag.samples;
    });
    // Basecamp has no stream: its banner or its icon lights the room now.
    await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-source', /^(banner|icon)$/);

    expectMoment('room (server switch)', crossfade, {
      plays: [{ match: transitionOf('opacity', 'glass-room-backdrop__layer'), duration: constants.glassMsRoom, cites: '--glass-ms-room', atLeast: 2 }],
      // The room is what eases for 1.2s, so the window's ceiling is the room's own.
      ceiling: constants.glassMsRoom,
      // The switch renders the other server's places panel and conversation while the crossfade
      // starts: React's work on the page, in a dev build, is the long frames (see KNOWN).
      ...KNOWN.switchesServer,
    });
    // Both canvases are partly visible mid-fade, and exactly one is at the end.
    const mid = fade.find((sample) => sample.at >= constants.glassMsRoom / 2);
    expect(mid?.opacities.every((opacity) => opacity > 0.05 && opacity < 0.95), `mid-fade opacities ${JSON.stringify(mid)}`).toBe(true);
    expect([...fade[fade.length - 1].opacities].sort()).toEqual([0, 1]);
  });

  test('phone: places and the conversation are two screens, and the change between them is a 360ms slide', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, { width: 390, height: 844 });
    const frame = page.locator('.glass-frame');
    await expect(frame).toHaveAttribute('data-screen', 'conversation');
    const clips = page.getByRole('navigation', { name: 'Channels' }).getByRole('link', { name: /Clips/ });
    // Open Clips once and come back to places: its timeline is in the stores, so what the window
    // measures is the slide, not the first render of a channel's messages.
    await page.getByRole('button', { name: 'Back to places' }).click();
    await expect(frame).toHaveAttribute('data-screen', 'places');
    await clips.click();
    await expect(frame).toHaveAttribute('data-screen', 'conversation');
    await expect(page.getByRole('heading', { level: 1, name: 'Clips' })).toBeVisible();
    await page.waitForTimeout(1500);
    await clearToasts(page);

    const toPlaces = await measureMoment(page, async () => {
      await page.getByRole('button', { name: 'Back to places' }).click();
    }, 700);
    await expect(frame).toHaveAttribute('data-screen', 'places');
    expectMoment('phone (conversation -> places)', toPlaces, {
      plays: [{ match: (r) => r.id.startsWith('glass-phone:'), duration: constants.PHONE_SLIDE_MS, cites: 'PHONE_SLIDE_MS', atLeast: 2 }],
    });

    const toConversation = await measureMoment(page, async () => {
      await clips.click();
    }, 700);
    await expect(frame).toHaveAttribute('data-screen', 'conversation');
    expectMoment('phone (places -> conversation)', toConversation, {
      plays: [{ match: (r) => r.id.startsWith('glass-phone:'), duration: constants.PHONE_SLIDE_MS, cites: 'PHONE_SLIDE_MS', atLeast: 2 }],
      // The channel's own page crossfades in under the slide (the route content swap).
      ceiling: constants.PHONE_SLIDE_MS,
    });
  });

  test('shared element (lib/motion/sharedElement.ts): View Transitions and FLIP are one choreography of --duration-move', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1200 });
    // No Glass scene here: it pins the page's Date, and the engine's "wait for the chrome to arrive"
    // loop counts Date.now() down to its deadline, which a pinned clock never reaches (a walk back,
    // with no chrome to rise, would wait for ever). The demo needs no account and no server.
    await page.goto('/design-tokens');
    constants = await readMotionConstants(page);
    const shared = page.locator('#motion-shared');
    await shared.scrollIntoViewIfNeeded();
    await expect(shared).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);

    // The Web Animations FLIP path: the one this engine is answerable for, frames and all.
    const flip = await measureMoment(page, async () => {
      await shared.getByRole('button', { name: /\(FLIP\)$/ }).click();
    }, 1000);
    await expect(shared.getByText('Last run: flip.')).toBeVisible();
    expectMoment('shared element (FLIP)', flip, {
      plays: [{ match: (r) => r.id === 'data-motion-recipe:shared', duration: constants.durationMove, cites: '--duration-move' }],
    });

    // The View Transitions path, where the webview has it: the same choreography and duration and the
    // same law; its frames are the compositor's bill on a runner with no GPU, and are not gated.
    const viewTransition = await measureMoment(page, async () => {
      await shared.getByRole('button', { name: /^(?:Walk into the channel|Back to the Lobby)$/ }).click();
    }, 1000);
    await expect(shared.getByText('Last run: view-transition.')).toBeVisible();
    expectMoment('shared element (View Transitions)', viewTransition, {
      // The shared element's own snapshot group and its cross-fade; the page's root snapshot
      // cross-fades for --duration-fast alongside it.
      plays: [{ match: (r) => r.target.includes('::view-transition') && r.target.includes('pc-tokens-room'), duration: constants.durationMove, cites: '--duration-move', atLeast: 2 }],
      frames: false,
    });
  });

  test.describe('reduced motion: a layout change is a 150ms crossfade, and nothing loops', () => {
    async function expectCrossfade(label: string, sample: MomentSample, constant: number, cites: string, match: (r: AnimationRecord) => boolean) {
      const finite = sample.records.filter((record) => !record.loops);
      const played = finite.filter(match);
      expect(played.length, `${label}: the crossfade never played (saw ${finite.map((r) => `${r.kind}:${r.id}`).join(', ') || 'none'})`).toBeGreaterThan(0);
      for (const record of played) {
        expect(record.duration, `${label}: "${record.id}" is ${cites} = ${constant}ms under reduced motion`).toBe(constant);
        // Nothing travels: every keyframe's transform is the rest one.
        for (const transform of record.transforms) {
          expect(transform === 'none' || /^translate\(0(px)?, ?0(px)?\) scale\(1, ?1\)$/.test(transform), `${label}: "${record.id}" travels (${transform}) under reduced motion`).toBe(true);
        }
      }
      // And nothing runs longer than the crossfade.
      expect(
        finite.filter((record) => (record.duration ?? 0) > constant).map((record) => `${record.kind}:${record.id}@${record.target} ${record.duration}ms`),
        `${label}: something runs longer than ${constant}ms under reduced motion`,
      ).toEqual([]);
      expect(sample.records.filter((record) => record.loops).map((record) => `${record.id}@${record.target}`), `${label}: a loop is still running`).toEqual([]);
    }

    test('the moves become 150ms crossfades, the spring plays nothing, and the waveform stops', async ({ page }) => {
      test.setTimeout(150_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page);
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
      // The loops are off: no infinite animation is running anywhere on the page.
      const loops = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => (a.effect as KeyframeEffect | null)?.getComputedTiming?.().iterations === Infinity && a.playState === 'running')
          .map((a) => a.id || (a as CSSAnimation).animationName || 'anonymous'),
      );
      expect(loops, 'loops still running under reduced motion').toEqual([]);

      // The pill's spring plays nothing; its roster crossfades (CSS), which reduced motion zeroes.
      const faces = pill(page).getByRole('button', { name: "Show who's in Lounge" });
      const expanding = await measureMoment(page, async () => {
        await faces.click();
      }, 500);
      await expect(pill(page)).toHaveAttribute('data-phase', 'expanded');
      expect(expanding.records.filter((r) => r.id.startsWith('glass-pill:')).map((r) => r.id), 'the pill\'s spring under reduced motion').toEqual([]);
      await faces.click();
      await expect(pill(page)).toHaveAttribute('data-phase', 'compact');

      // pill -> stage, then T, then S: each is a 150ms crossfade in place.
      await fakeMedia(page, { joined: true });
      const opening = await measureMoment(page, async () => {
        await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
      }, 600);
      await expect(stagePane(page)).toBeVisible();
      await expectCrossfade('reduced: pill -> stage', opening, constants.STAGE_CROSSFADE_MS, 'STAGE_CROSSFADE_MS', isMorph);
      await settled(page);

      const theater = await measureMoment(page, async () => {
        await page.keyboard.press('t');
      }, 600);
      await expectCrossfade('reduced: theater (T)', theater, constants.STAGE_CROSSFADE_MS, 'STAGE_CROSSFADE_MS', isMorph);
      await settled(page);

      await page.keyboard.press('t');
      await settled(page);
      const browse = await measureMoment(page, async () => {
        await page.keyboard.press('s');
      }, 600);
      await expectCrossfade('reduced: browse (S)', browse, constants.STAGE_CROSSFADE_MS, 'STAGE_CROSSFADE_MS', isMorph);
      await settled(page);
    });

    test('the phone\'s screen change and the room are 150ms crossfades', async ({ page }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, { width: 390, height: 844 });
      const toPlaces = await measureMoment(page, async () => {
        await page.getByRole('button', { name: 'Back to places' }).click();
      }, 500);
      await expect(page.locator('.glass-frame')).toHaveAttribute('data-screen', 'places');
      await expectCrossfade('reduced: phone screens', toPlaces, constants.PHONE_FADE_MS, 'PHONE_FADE_MS', (r) => r.id.startsWith('glass-phone:'));
      // Both screens crossfade: an opacity animation each, and no slide.
      const screens = toPlaces.records.filter((r) => r.id.startsWith('glass-phone:'));
      expect(screens.length).toBeGreaterThanOrEqual(2);
      for (const record of screens) expect(record.properties.includes('opacity'), `${record.id} crossfades`).toBe(true);
    });

    test('a server switch eases the room over 150ms, not 1.2s', async ({ page }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page);
      const basecamp = page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /^Basecamp/ });
      const crossfade = await measureMoment(page, async () => {
        await basecamp.click();
      }, 800);
      await expect(page.locator('.glass-room-backdrop')).toHaveAttribute('data-room-source', /^(banner|icon)$/);
      await expectCrossfade('reduced: room', crossfade, constants.glassMsReduced, '--glass-ms-reduced', transitionOf('opacity', 'glass-room-backdrop__layer'));
    });
  });

  test('motion is on when it should be: the waveform loops, and is the only loop', async ({ page }) => {
    await open(page);
    // The counterpart of the reduced-motion case: a gate that never saw a loop would pass "no loops" on a dead page.
    const loops = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect | null)?.getComputedTiming?.().iterations === Infinity && a.playState === 'running')
        .map((a) => (a as CSSAnimation).animationName || a.id || 'anonymous'),
    );
    expect(loops.length, 'the talking waveform is on the pill').toBeGreaterThan(0);
  });
});
