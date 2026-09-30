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
 */
const BARS = [
  { height: 7, duration: 0.9, delay: 0.1, gain: 0.85 },
  { height: 12, duration: 1.1, delay: 0.3, gain: 1 },
  { height: 14, duration: 0.8, delay: 0, gain: 0.9 },
  { height: 11, duration: 1.2, delay: 0.2, gain: 0.95 },
  { height: 6, duration: 1, delay: 0.4, gain: 0.75 },
] as const;

export interface WaveformProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Real voice level, 0 to 1. Omit for the looping animation. */
  level?: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

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
                : { animationDuration: `${bar.duration}s`, animationDelay: `${bar.delay}s` }),
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
