import * as React from 'react';
import { useLayoutEffect, useRef } from 'react';

import { motionToken, ms, prefersReducedMotion } from '../../lib/motion';
import { cn, mergeRefs } from '../../lib/utils';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

// A placeholder is a matte wash, gently pulsed — never a sweeping sheen
// (§6.2: no gradient wash across a surface). The pulse is opacity-only, and it
// lives in `.pc-skeleton` so the one reduced-motion switch can stop it dead
// rather than landing it on its end frame through the global 0s override (§5.3:
// "loading skeletons crossfade to content, they do not pulse forever").
export function Skeleton({ width, height, borderRadius = 'var(--radius-chip)', className = '' }: SkeletonProps) {
  return (
    <div
      className={cn('pc-skeleton', className)}
      style={{
        width,
        height,
        borderRadius,
        backgroundColor: 'var(--bg-mod-strong)',
      }}
    />
  );
}

export interface SkeletonSwapProps extends React.HTMLAttributes<HTMLDivElement> {
  /** True while the placeholder is what is being rendered. */
  busy: boolean;
}

/**
 * The crossfade §5.3 asks for: "loading skeletons crossfade to content".
 *
 * Wrap a `busy ? placeholder : content` branch in this and the swap stops being
 * a frame cut. While `busy`, it keeps a picture of the placeholder; on the
 * commit where `busy` drops it paints that picture back over itself as an
 * `aria-hidden` ghost, fades the ghost out and the real content in over
 * --duration-normal, and drops the ghost.
 *
 * The ghost is positioned over the wrapper rather than in flow, so the content
 * lands at its final size on the first frame — no delayed content, and nothing
 * below it moves. Nothing plays when the content was never loading (§5.3: never
 * on first paint), and under reduced motion the content is simply there.
 */
export const SkeletonSwap = React.forwardRef<HTMLDivElement, SkeletonSwapProps>(function SkeletonSwap(
  { busy, className, children, ...props },
  forwarded,
) {
  const host = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLElement | null>(null);
  const wasBusy = useRef(busy);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    if (busy) {
      wasBusy.current = true;
      picture.current =
        typeof element.cloneNode === 'function' && element.childElementCount > 0
          ? (element.cloneNode(true) as HTMLElement)
          : null;
      return;
    }
    const ghost = picture.current;
    picture.current = null;
    if (!wasBusy.current) return;
    wasBusy.current = false;
    if (!ghost || prefersReducedMotion() || typeof element.animate !== 'function') return;

    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      margin: '0',
      pointerEvents: 'none',
    });
    element.append(ghost);

    const duration = ms('--duration-normal');
    const easing = motionToken('--ease-out');
    const drop = () => ghost.remove();
    const leaving = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration,
      easing,
      fill: 'forwards',
    });
    leaving.finished.then(drop, drop);
    leaving.addEventListener('cancel', drop);
    element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing, fill: 'backwards' });
    // The ghost is scenery: it cannot outlive the crossfade whatever happens.
    window.setTimeout(drop, duration + 400);
  }, [busy]);

  return (
    <div ref={mergeRefs(forwarded, host)} className={cn('relative', className)} {...props}>
      {children}
    </div>
  );
});

export function SkeletonMessage() {
  return (
    <div className="flex gap-3 px-3 py-2" style={{ marginTop: '1rem' }}>
      <Skeleton width={40} height={40} borderRadius="var(--radius-full)" className="shrink-0" />
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-2 mb-1.5">
          <Skeleton width="30%" height={14} borderRadius="var(--radius-chip)" />
          <Skeleton width={48} height={10} borderRadius="var(--radius-chip)" />
        </div>
        <Skeleton width="90%" height={14} borderRadius="var(--radius-chip)" />
        <div className="mt-1">
          <Skeleton width="60%" height={14} borderRadius="var(--radius-chip)" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonChannel() {
  return (
    <div className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5">
      <Skeleton width={16} height={16} borderRadius="var(--radius-chip)" className="shrink-0" />
      <Skeleton width="70%" height={14} borderRadius="var(--radius-chip)" />
    </div>
  );
}

export function SkeletonMember() {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5">
      <Skeleton width={32} height={32} borderRadius="var(--radius-full)" className="shrink-0" />
      <Skeleton width="60%" height={14} borderRadius="var(--radius-chip)" />
    </div>
  );
}
