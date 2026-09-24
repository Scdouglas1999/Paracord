/**
 * Reading §5's motion tokens from the document.
 *
 * The engine never writes a duration or a curve of its own: every number it
 * animates with comes from `src/styles/tokens.css`, so a change there moves the
 * whole app. The fallbacks below exist for one case only — a renderer with no
 * stylesheet attached (jsdom in the unit suite) — and they are the same values
 * the stylesheet declares. If they ever disagree, `motion.tokens.test.ts`
 * fails.
 */

/** The §5 tokens the engine consumes, with their stylesheet values. */
export const MOTION_TOKEN_FALLBACKS = {
  '--duration-fast': '120ms',
  '--duration-normal': '180ms',
  '--duration-slow': '240ms',
  '--duration-page': '420ms',
  '--duration-exit': '130ms',
  '--duration-exit-slow': '170ms',
  '--duration-warm-up': '220ms',
  '--duration-dim': '400ms',
  '--duration-breathe': '1600ms',
  '--duration-glow': '2000ms',
  '--duration-burst': '1400ms',
  '--duration-move': '320ms',
  '--duration-roll': '180ms',
  '--ease-out': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  '--ease-in': 'cubic-bezier(0.4, 0, 1, 1)',
  '--ease-in-out': 'cubic-bezier(0.45, 0, 0.55, 1)',
  '--stagger-page': '40ms',
  '--stagger-light': '30ms',
  '--stagger-chrome': '80ms',
  '--spring-stiffness': '260',
  '--spring-damping': '34',
  '--spring-mass': '1',
} as const;

export type MotionTokenName = keyof typeof MOTION_TOKEN_FALLBACKS;

/** The token's current value as a string, or its stylesheet value off-DOM. */
export function motionToken(name: MotionTokenName): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return MOTION_TOKEN_FALLBACKS[name];
  }
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return resolved || MOTION_TOKEN_FALLBACKS[name];
}

/** `220ms` / `0.22s` / `220` → 220. */
export function parseDuration(value: string): number {
  const match = /^(-?\d*\.?\d+)\s*(ms|s)?$/.exec(value.trim());
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;
  return match[2] === 's' ? amount * 1000 : amount;
}

/**
 * Any custom property off the document root, for the two places WAAPI has to be
 * handed a resolved value: it does not substitute `var()` inside a keyframe.
 * Returns '' off-DOM, and callers fall back to not painting that property.
 */
export function rawToken(name: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A duration token in milliseconds. */
export function ms(name: MotionTokenName): number {
  return parseDuration(motionToken(name));
}

/** A unitless token (the spring constants) as a number. */
export function num(name: MotionTokenName): number {
  const parsed = Number.parseFloat(motionToken(name));
  return Number.isFinite(parsed) ? parsed : Number.parseFloat(MOTION_TOKEN_FALLBACKS[name]);
}
