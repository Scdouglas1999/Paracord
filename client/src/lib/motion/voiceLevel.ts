import { SPEAKING_MARK, PERSON_MARK } from './marks';
import { prefersReducedMotion } from './reducedMotion';

/**
 * "Speaking is a breath" — and, where the engine knows how loud, the breath
 * takes the voice (docs/lantern-stage-spec.md §5.1).
 *
 * §5.1: *"The speaking ring breathes between the two alphas in §1.2 at ~1.6 s
 * and, where the engine exposes level, brightens with the voice (±15 %
 * intensity, 60 ms attack / 240 ms release) — never below the resting ring."*
 *
 * The CSS half is `primitives.css`: `.pc-speaking` composes a second glow layer
 * out of `--voice-level`, so the ring rises from where it rests and can never
 * fall below it. This module is the other half — the thing that writes that
 * number — and everything about its shape is about cost, because it is the only
 * part of the engine that runs on EVERY frame for as long as somebody is
 * talking.
 *
 * Four rules, and each of them is load-bearing:
 *
 *   1. **One loop for every tile.** Not one per `StageTile`, not one per
 *      `LitAvatar`. A ten-person room is one `requestAnimationFrame` callback,
 *      and it exits the moment the last voice has released to silence.
 *   2. **No React state, ever.** A level is 50 updates a second; a store write
 *      would re-render the room fifty times a second to change a glow. The
 *      engine writes the custom property straight onto DOM it found, which is
 *      also why a re-render cannot wipe it — the property is re-applied on the
 *      next frame regardless.
 *   3. **Nothing is allocated per frame.** The elements are collected when the
 *      engine publishes (a few times a second), never in the loop; the level is
 *      quantised to 1/64 and looked up in a table of strings built once, so a
 *      frame that does not change a ring writes nothing at all and a frame that
 *      does allocates nothing.
 *   4. **A level is never invented.** `publish` takes what the media engine
 *      actually reported. Where an engine reports speaking but no level, the
 *      ring simply breathes — which is §5.1's "where the engine exposes level".
 */

/** The custom property `primitives.css` reads. */
export const VOICE_LEVEL_VAR = '--voice-level';

/** §5.1: the ring is at the voice within 60ms of it. */
export const VOICE_ATTACK_MS = 60;
/** §5.1: and takes 240ms to let go of it, so it never chatters. */
export const VOICE_RELEASE_MS = 240;

/**
 * The level is written at 1/64, which is finer than the 15% of an alpha it
 * drives can render and coarse enough that a steady voice stops writing.
 */
const STEPS = 64;

/** Every value the property can ever take, built once. Nothing else allocates. */
const LEVEL_STRINGS: string[] = Array.from({ length: STEPS + 1 }, (_, index) =>
  (index / STEPS).toFixed(4),
);

/**
 * Where a level comes from. Two engines can be talking at once — the room's own
 * speaker report and the local microphone's analyser, which is faster and knows
 * about you before the server does — and each replaces only its own picture.
 * The loudest observation of a person wins, because a person who is audible on
 * either path is audible.
 */
export type VoiceLevelSource = 'room' | 'self';

interface Tracked {
  /** Where the envelope is right now. */
  level: number;
  /** Where it is heading — the loudest published observation. */
  target: number;
  /** The last 1/64 step actually written, so a steady voice writes nothing. */
  written: number;
  /** The elements carrying this person's ring, re-collected on every publish. */
  elements: HTMLElement[];
}

const published = new Map<VoiceLevelSource, Map<string, number>>();
const tracked = new Map<string, Tracked>();
let frame: number | null = null;
/**
 * -1 while the loop is not running: a frame timestamp can legitimately be 0,
 * and the first frame after a report has had no time to advance anything.
 */
let lastFrameAt = -1;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The elements that draw one person's ring.
 *
 * Two marks, because a person is drawn in two shapes: `data-motion-person` is
 * the `LitAvatar` root (the property inherits down to the rim inside it) and
 * `data-motion-speaking` is anything else that carries the ring itself — a
 * `StageTile` is a 12px well with a ring, not a face.
 */
function collect(userId: string): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(userId) : userId;
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[${PERSON_MARK}="${escaped}"],[${SPEAKING_MARK}="${escaped}"]`,
    ),
  ];
}

/** The loudest thing any source says about this person right now. */
function targetFor(userId: string): number {
  let loudest = 0;
  for (const levels of published.values()) {
    const level = levels.get(userId);
    if (level != null && level > loudest) loudest = level;
  }
  return loudest;
}

function write(entry: Tracked, step: number): void {
  entry.written = step;
  const value = LEVEL_STRINGS[step];
  for (const element of entry.elements) element.style.setProperty(VOICE_LEVEL_VAR, value);
}

function release(entry: Tracked): void {
  for (const element of entry.elements) element.style.removeProperty(VOICE_LEVEL_VAR);
}

/**
 * One frame: advance every envelope, write the ones that moved a step.
 *
 * The envelope is a linear slew, not an exponential one, so "60 ms attack"
 * means exactly that — silence to full takes 60 ms and a unit test can hold it.
 */
function tick(now: number): void {
  frame = null;
  const elapsed = lastFrameAt < 0 ? 0 : Math.min(64, Math.max(0, now - lastFrameAt));
  lastFrameAt = now;

  let alive = false;
  for (const [userId, entry] of tracked) {
    const target = entry.target;
    if (target > entry.level) {
      entry.level = Math.min(target, entry.level + elapsed / VOICE_ATTACK_MS);
    } else if (target < entry.level) {
      entry.level = Math.max(target, entry.level - elapsed / VOICE_RELEASE_MS);
    }
    const step = Math.round(entry.level * STEPS);
    if (step !== entry.written) write(entry, step);
    // Silent, and the envelope has finished letting go: the ring is back at
    // rest and there is nothing left to drive.
    if (step === 0 && target === 0) {
      release(entry);
      tracked.delete(userId);
      continue;
    }
    alive = true;
  }

  if (alive) frame = requestAnimationFrame(tick);
  else lastFrameAt = -1;
}

function start(): void {
  if (frame != null || typeof requestAnimationFrame !== 'function') return;
  frame = requestAnimationFrame(tick);
}

/**
 * What one source can hear, right now: user id → 0 (silence) … 1 (full voice).
 *
 * Called at the media engine's own cadence — a few times a second, not per
 * frame. This is also where the DOM is re-read, so a tile that mounted since
 * the last report starts being driven without the loop ever touching a
 * selector.
 */
export function publishVoiceLevels(
  source: VoiceLevelSource,
  levels: ReadonlyMap<string, number>,
): void {
  if (typeof document === 'undefined') return;
  // §5.3's one switch. Under reduced motion the ring does not breathe either
  // (`primitives.css`), so there is nothing for a level to modulate.
  if (prefersReducedMotion()) {
    clearVoiceLevels();
    return;
  }

  const next = new Map<string, number>();
  for (const [userId, level] of levels) {
    const value = clamp01(Number.isFinite(level) ? level : 0);
    if (value > 0) next.set(userId, value);
  }
  published.set(source, next);

  // Everybody any source has an opinion about — including the people this
  // source has just stopped hearing, who need a target of 0 to release.
  for (const known of published.values()) {
    for (const userId of known.keys()) {
      let entry = tracked.get(userId);
      if (!entry) {
        entry = { level: 0, target: 0, written: -1, elements: [] };
        tracked.set(userId, entry);
      }
      entry.elements = collect(userId);
      // A tile that mounted since the last report starts where the voice
      // already is, rather than waiting for the level to happen to change
      // step — which for a steady voice could be the rest of the sentence.
      if (entry.written >= 0) write(entry, entry.written);
    }
  }
  for (const [userId, entry] of tracked) entry.target = targetFor(userId);
  if (tracked.size > 0) start();
}

/**
 * Everybody has stopped talking to us — a call ended, the engine went away, the
 * switch moved to reduced motion. Every ring goes back to resting immediately:
 * a release would be pretending we still know how loud somebody is.
 */
export function clearVoiceLevels(): void {
  published.clear();
  for (const entry of tracked.values()) release(entry);
  tracked.clear();
  if (frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  frame = null;
  lastFrameAt = -1;
}

/**
 * The RTP audio-level convention the native engine speaks: 0–127, as −dBov, so
 * **lower is louder** (`browserMediaEngine` calls somebody speaking below 80).
 *
 * The window is the one voice actually lives in: the noise gate opens at
 * −45 dBFS and speech peaks around −10, so 45 is silence and 10 is full. A
 * linear map over 80 dB would leave every ordinary voice in the bottom eighth
 * of the range and the moment would never be visible.
 */
export function levelFromDbov(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return clamp01((45 - raw) / 35);
}

/**
 * The local analyser's own reading (LiveKit's `calculateVolume`, 0-1 RMS).
 *
 * An ordinary speaking voice through a normalised mic sits around 0.05-0.25 of
 * full scale — the store's own speaking threshold is 0.055 — so the raw number
 * would leave the ring in the bottom quarter of its travel for every real
 * voice. 0.25 is taken as full, which is where the store's hysteresis says a
 * voice clearly is.
 */
export function levelFromAnalyser(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  return clamp01(volume / 0.25);
}

/** For tests: what the engine currently believes, without touching the DOM. */
export function voiceLevelsForTests(): Map<string, { level: number; target: number }> {
  const out = new Map<string, { level: number; target: number }>();
  for (const [userId, entry] of tracked) out.set(userId, { level: entry.level, target: entry.target });
  return out;
}

/** For tests: run one frame of the envelope by hand. */
export function stepVoiceLevelsForTests(nowMs: number): void {
  if (frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  frame = null;
  tick(nowMs);
}
