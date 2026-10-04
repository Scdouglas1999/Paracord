import * as React from 'react';
import { cn } from '../../../lib/utils';

/**
 * The talking waveform (docs/glass-spec.md §2.5): five rounded bars, 3px wide,
 * 2px apart, heights 7 / 12 / 14 / 11 / 6, amber, each `scaleY(.35 <-> 1)` on
 * its own 0.8-1.2s loop. Only transform animates.
 *
 * With `level` (0-1, the speaker's real voice activity) the loop stops and each
 * bar follows the voice instead: its scale is `.35 + .65 * level`, shaped by a
 * fixed per-bar gain so the five bars do not move in lockstep. Reduced motion
 * is the `data-motion` switch (glass.css): the bars hold still.
 *
 * The loop ticks in 100ms steps on one grid (every duration is a multiple of
 * 0.2s and every delay of 0.1s, so all five bars change on the same frames):
 * 10 pictures a second. On the Linux desktop every animated frame is a whole
 * window copied over shared memory. Five tiny bars at 60 frames cost about 26%
 * of a core in WebKitWebProcess and 20% in the app; on a 50ms grid about 12%
 * and 7% (WP-G23). With a call in the pill and the window otherwise idle, the
 * 50ms grid still kept WebKitWebProcess at about 11% and the app at 7%; on the
 * 100ms grid they are about 6% and 3% (release check, 2026-10-04).
 */
const BARS = [
  { height: 7, duration: 1, delay: 0.1, gain: 0.85 },
  { height: 12, duration: 1.2, delay: 0.3, gain: 1 },
  { height: 14, duration: 0.8, delay: 0, gain: 0.9 },
  { height: 11, duration: 1, delay: 0.2, gain: 0.95 },
  { height: 6, duration: 1.2, delay: 0.4, gain: 0.75 },
] as const;

/** One step of the loop, in seconds: the grid every bar ticks on. */
export const WAVE_STEP_SECONDS = 0.1;

export interface WaveformProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Real voice level, 0 to 1. Omit for the looping animation. */
  level?: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Steps for each half of a bar's loop (0.35 to 1, then back) so one step is {@link WAVE_STEP_SECONDS}. */
export function loopSteps(duration: number): number {
  return Math.max(1, Math.round((duration / 2) / WAVE_STEP_SECONDS));
}

export function barScale(level: number, gain: number): number {
  return 0.35 + 0.65 * clamp01(level * gain);
}

export function Waveform({ level, className, style, ...rest }: WaveformProps) {
  const live = level !== undefined;
  return (
    <span
      aria-hidden="true"
      className={cn('glass-wave', className)}
      data-live-level={live ? '' : undefined}
      style={style}
      {...rest}
    >
      {BARS.map((bar, index) => (
        <span
          key={index}
          style={
            {
              height: bar.height,
              ...(live
                ? { '--wave-scale': barScale(level, bar.gain).toFixed(3) }
                : {
                    animationDuration: `${bar.duration}s`,
                    animationDelay: `${bar.delay}s`,
                    animationTimingFunction: `steps(${loopSteps(bar.duration)}, jump-none)`,
                  }),
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
