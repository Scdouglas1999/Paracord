import { useEffect, useRef, useState } from 'react';

import { cn } from '../utils';
import { prefersReducedMotion } from './reducedMotion';
import { motionToken, ms } from './tokens';

/**
 * `<RollingNumber>` — §5.1's "numbers re-roll".
 *
 * Any count that changes flips vertically: the old value rolls up and out, the
 * new one rolls up and in, 180ms (`--duration-roll`). It only ever animates on
 * a CHANGE — a count that is simply rendered has not been caused by anybody, and
 * §5.3 forbids animating on first paint.
 *
 * Accessibility: the roll itself is `aria-hidden` scenery. The value a screen
 * reader gets is a single polite live region carrying the final number once, so
 * a re-roll announces "5", never "4… 5" or the same number twice.
 */

export interface RollingNumberProps {
  value: number;
  /** How the number reads. Defaults to the plain integer. */
  format?: (value: number) => string;
  className?: string;
  /**
   * Announce a change politely. Turn it OFF for one of several numbers in the
   * same sentence and let the sentence announce itself once — the number stays
   * in the accessible name either way (§9: light always has words).
   */
  announce?: boolean;
}

export function RollingNumber({ value, format, className, announce = true }: RollingNumberProps) {
  const render = format ?? ((n: number) => String(n));
  const [outgoing, setOutgoing] = useState<number | null>(null);
  const previous = useRef(value);
  const incomingRef = useRef<HTMLSpanElement>(null);
  const outgoingRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value) return;
    if (prefersReducedMotion()) return;
    setOutgoing(from);
  }, [value]);

  useEffect(() => {
    if (outgoing === null) return;
    const incoming = incomingRef.current;
    const leaving = outgoingRef.current;
    const duration = ms('--duration-roll');
    const easing = motionToken('--ease-out');
    const animations: Animation[] = [];
    if (leaving && typeof leaving.animate === 'function') {
      animations.push(
        leaving.animate(
          [
            { transform: 'translate3d(0, 0, 0)', opacity: 1 },
            { transform: 'translate3d(0, -100%, 0)', opacity: 0 },
          ],
          { duration, easing, fill: 'forwards' },
        ),
      );
    }
    if (incoming && typeof incoming.animate === 'function') {
      animations.push(
        incoming.animate(
          [
            { transform: 'translate3d(0, 100%, 0)', opacity: 0 },
            { transform: 'translate3d(0, 0, 0)', opacity: 1 },
          ],
          { duration, easing, fill: 'backwards' },
        ),
      );
    }
    let cancelled = false;
    const done = () => {
      if (!cancelled) setOutgoing(null);
    };
    if (animations.length === 0) {
      done();
      return;
    }
    Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(done);
    return () => {
      cancelled = true;
      for (const animation of animations) animation.cancel();
    };
  }, [outgoing]);

  return (
    // One accessible text node — the current value — inside a region that
    // speaks on a change. The value on its way out is `aria-hidden`, so the
    // roll is scenery and the region's atomic text never changes twice.
    <span
      className={cn('relative inline-flex overflow-hidden align-bottom tabular-nums', className)}
      aria-live={announce ? 'polite' : 'off'}
      aria-atomic="true"
    >
      <span ref={incomingRef} className="inline-block">
        {render(value)}
      </span>
      {outgoing !== null && (
        <span ref={outgoingRef} aria-hidden className="absolute inset-0 inline-block">
          {render(outgoing)}
        </span>
      )}
    </span>
  );
}
