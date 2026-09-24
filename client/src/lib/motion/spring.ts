import { motionToken, num } from './tokens';

/**
 * The spring solver behind §5.2.
 *
 * The motion law has ONE curve for things that arrive or move, `--ease-out`,
 * and no overshoot anywhere. The spring exists for the one thing a fixed
 * cubic-bezier cannot do: carry the velocity of an animation that was
 * interrupted into the one that replaces it (§5.3 "animations are
 * interruptible and retarget"). So:
 *
 *   - a fresh animation (no velocity to carry) gets the `--ease-out` token;
 *   - a retarget gets a WAAPI `linear()` easing sampled from the real
 *     solution of a critically damped spring (the `--spring-*` tokens:
 *     stiffness 260 / damping 34 / mass 1), which never overshoots;
 *   - a webview without `linear()` gets `--ease-out` either way.
 */

export interface SpringConfig {
  /** `--spring-stiffness`. */
  stiffness: number;
  /** `--spring-damping`. */
  damping: number;
  /** `--spring-mass`. */
  mass: number;
  /** Initial velocity in progress-units per second (a retarget supplies it). */
  velocity?: number;
}

/** The §5.2 spring, read from the tokens in force. */
export function springTokens(): SpringConfig {
  return {
    stiffness: num('--spring-stiffness'),
    damping: num('--spring-damping'),
    mass: num('--spring-mass'),
  };
}

/**
 * Displacement remaining at `tMs`, for a spring released from 1 with velocity
 * `velocity` and resting at 0. Progress is `1 - displacement`.
 */
export function springDisplacement(tMs: number, config: SpringConfig): number {
  const { stiffness, damping, mass } = config;
  const velocity = config.velocity ?? 0;
  const t = Math.max(0, tMs) / 1000;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  // x(0) = 1, x'(0) = -velocity (velocity is measured toward the target).
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const a = 1;
    const b = (zeta * w0 - velocity) / wd;
    return Math.exp(-zeta * w0 * t) * (a * Math.cos(wd * t) + b * Math.sin(wd * t));
  }
  if (zeta === 1) {
    return Math.exp(-w0 * t) * (1 + (w0 - velocity) * t);
  }
  // Overdamped: two real roots, x(t) = A e^(r1 t) + B e^(r2 t).
  const wd = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + wd;
  const r2 = -zeta * w0 - wd;
  const a = (-velocity - r2) / (r1 - r2);
  const b = 1 - a;
  return a * Math.exp(r1 * t) + b * Math.exp(r2 * t);
}

/** Normalised progress 0 → 1 at `tMs`. At the token damping it never passes 1. */
export function springProgress(tMs: number, config: SpringConfig): number {
  return 1 - springDisplacement(tMs, config);
}

const REST_DISPLACEMENT = 0.001;
const MAX_DURATION_MS = 500;

/**
 * How long the spring takes to come to rest, rounded up to the next 10ms and
 * capped at §5.3's 500ms ceiling.
 */
export function springDuration(config: SpringConfig): number {
  for (let t = 10; t <= MAX_DURATION_MS; t += 10) {
    let settled = true;
    for (let probe = t; probe <= Math.min(MAX_DURATION_MS, t + 60); probe += 10) {
      if (Math.abs(springDisplacement(probe, config)) > REST_DISPLACEMENT) {
        settled = false;
        break;
      }
    }
    if (settled) return t;
  }
  return MAX_DURATION_MS;
}

/** Whether this engine can take a sampled `linear()` easing. */
export function supportsLinearEasing(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('animation-timing-function', 'linear(0, 1)')
  );
}

export interface SpringEasingOptions {
  /** Sample count. 24 is smooth enough that the sampled and token curves read alike. */
  samples?: number;
  /** The window the easing is stretched over; defaults to `springDuration`. */
  durationMs?: number;
}

/**
 * A `linear()` easing string sampled from the solution, for
 * `Element.animate(..., { easing })`.
 */
export function springLinearEasing(config: SpringConfig, options: SpringEasingOptions = {}): string {
  const samples = Math.max(4, options.samples ?? 24);
  const duration = options.durationMs ?? springDuration(config);
  const raw: number[] = [];
  for (let i = 0; i <= samples; i += 1) raw.push(springProgress((i / samples) * duration, config));
  // The window is usually shorter than the spring's own settling time, so the
  // last sample sits a whisker short of 1. Normalise on it: an easing MUST end
  // at exactly 1 or the element is left off its mark.
  const last = raw[raw.length - 1] || 1;
  const points = raw.map((value, i) =>
    (i === raw.length - 1 ? 1 : Number((value / last).toFixed(4))).toString(),
  );
  return `linear(${points.join(', ')})`;
}

/**
 * The easing the engine actually hands WAAPI: the sampled spring where a
 * velocity has to be carried and the engine supports `linear()`, the
 * `--ease-out` token otherwise. Both are §5.2-legal and neither overshoots.
 */
/**
 * Sampling the spring into a `linear()` string is real main-thread arithmetic,
 * and a moment can ask for the same curve a dozen times on one frame — a burst
 * of arrivals, or the travelling tile and the chrome behind it starting
 * together. The answer only depends on the four numbers below, all of them
 * tokens, so it is worth remembering. Small and bounded: the cache can only
 * ever hold one entry per (spring, duration, velocity) the product uses.
 */
const easingCache = new Map<string, string>();

export function springEasing(config?: SpringConfig, options: SpringEasingOptions = {}): string {
  const given = config ?? springTokens();
  if (!given.velocity || !supportsLinearEasing()) return motionToken('--ease-out');
  // A damped spring released TOWARD its target faster than its natural
  // frequency crosses the target once before settling — an overshoot by
  // another door. Cap the carried velocity just under that speed.
  const cap = 0.9 * Math.sqrt(given.stiffness / given.mass);
  const spring = { ...given, velocity: Math.min(given.velocity, cap) };
  const key = `${spring.stiffness}/${spring.damping}/${spring.mass}/${spring.velocity ?? 0}/${options.durationMs ?? ''}/${options.samples ?? ''}`;
  const cached = easingCache.get(key);
  if (cached !== undefined) return cached;
  const easing = springLinearEasing(spring, options);
  if (easingCache.size > 64) easingCache.clear();
  easingCache.set(key, easing);
  return easing;
}

/** What a running animation was doing when it was interrupted. */
export interface RetargetState {
  /** Progress 0…1 through the animation that was cut short. */
  progress: number;
  /** Velocity in progress-units per second at that instant. */
  velocity: number;
}

/**
 * Read a running WAAPI animation's position and velocity so a replacement can
 * pick up where it left off (§5.3: "animations are interruptible and retarget —
 * a spring, not a fixed tween").
 */
export function sampleRunning(animation: Animation | null | undefined): RetargetState {
  if (!animation) return { progress: 0, velocity: 0 };
  const timing = animation.effect?.getComputedTiming();
  const duration = typeof timing?.duration === 'number' ? timing.duration : 0;
  const elapsed = typeof animation.currentTime === 'number' ? animation.currentTime : 0;
  if (!duration) return { progress: 0, velocity: 0 };
  const progress = Math.min(1, Math.max(0, elapsed / duration));
  const spring = springTokens();
  // Central difference on the spring itself: the animation we are interrupting
  // was driven by this same solution, so its slope is the honest velocity.
  const step = 8;
  const before = springProgress(Math.max(0, elapsed - step), spring);
  const after = springProgress(elapsed + step, spring);
  const velocity = ((after - before) / (2 * step)) * 1000;
  return { progress, velocity };
}
