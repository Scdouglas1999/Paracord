import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { useReducedMotion } from '../../lib/motion/reducedMotion';
import { cn } from '../../lib/utils';
import { CORD_GEO, CORD_HIGHLIGHT } from './cordGeometry';
import {
  cordArtSrc,
  cordLevel,
  cordLoops,
  cordMotion,
  type CordLevel,
  type CordMotion,
  type CordTone,
} from './cordMarkModel';
import './cordMark.css';

export type { CordMotion, CordTone } from './cordMarkModel';

/**
 * Paracord's mark: a single paracord looped into a P, the bowl's end threaded
 * under the stem. The drawing lives in `client/brand/mark.html`; the art files
 * (`public/brand/cord-*.svg`), the geometry (`cordGeometry.ts`) and the motion
 * (`cordMark.css`) are generated from it by `client/brand/render.mjs`.
 *
 * `size` is the side of its square box, in px, and picks the level of detail:
 * the full braid from 64 px, a coarser braid from 24 px, and below that the flat
 * cord. `motion` (see {@link CordMotion}) never runs script per frame: the art
 * is static and only the dash values of the masks along its centerline move,
 * in CSS. Under reduced motion (the app's switch, which follows the OS unless
 * the user overrides it) the still mark is drawn. Looping motions pause while
 * the mark is offscreen, and the whole app's loops pause while the window is
 * hidden (lib/motion/visibility).
 *
 * Decorative unless it has a `label`, in which case it is an image with that
 * name. Loaders pair it with their own status text.
 */
export function CordMark({
  size = 40,
  motion = 'none',
  tone = 'ember',
  paused = false,
  label,
  className,
  style,
}: {
  size?: number;
  motion?: CordMotion;
  tone?: CordTone;
  /** Holds a looping motion on its first frame (the whole mark) until it is false. */
  paused?: boolean;
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const level = cordLevel(size);
  // The highlight needs the braid to run along; the one-color mark loads instead.
  const asked = tone === 'mono' && motion === 'working' ? 'loading' : motion;
  const mode = cordMotion(asked, useReducedMotion());
  const rawId = useId();
  const ref = useOffscreenPause<SVGSVGElement>(cordLoops(mode));
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };

  if (tone === 'ember' && mode === 'none') {
    return (
      <img
        src={cordArtSrc(level)}
        width={size}
        height={size}
        alt={label ?? ''}
        aria-hidden={label ? undefined : true}
        draggable={false}
        className={cn('pc-cord shrink-0 select-none', className)}
        style={style}
      />
    );
  }

  const id = `pc-cord-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [x, y, side] = CORD_GEO.box;
  const box = { x, y, width: side, height: side };
  const lw = tone === 'mono' ? CORD_GEO.width.mono : CORD_GEO.width[level];
  const gap = tone === 'mono' ? CORD_GEO.gap.mono : CORD_GEO.gap[level];
  const round = { fill: 'none', strokeLinecap: 'round' as const };
  const haloWidth = lw + 2 * gap;

  return (
    <svg
      ref={ref}
      viewBox={CORD_GEO.viewBox}
      width={size}
      height={size}
      focusable="false"
      data-motion={mode}
      data-level={tone === 'mono' ? 'mono' : level}
      data-paused={paused || undefined}
      className={cn('pc-cord shrink-0', mode !== 'none' && `pc-cord--${mode}`, className)}
      style={style}
      {...a11y}
    >
      {tone === 'mono' ? (
        <>
          {/* One color, often translucent text: the cord is drawn as a mask over one fill,
              so the halves never double up where they meet. Under half, the gap the stem
              cuts from it, then the over half, in that order. */}
          <defs>
            <mask id={`${id}m`} maskUnits="userSpaceOnUse" {...box}>
              <path d={CORD_GEO.paths.under} className="pc-cord__u" stroke="#fff" strokeWidth={lw} {...round} />
              <path d={CORD_GEO.paths.halo} className="pc-cord__h" stroke="#000" strokeWidth={haloWidth} {...round} />
              <path d={CORD_GEO.paths.over} className="pc-cord__o" stroke="#fff" strokeWidth={lw} {...round} />
            </mask>
          </defs>
          <rect {...box} fill="currentColor" mask={`url(#${id}m)`} />
        </>
      ) : (
        <EmberLayers id={id} level={level} mode={mode} box={box} revealWidth={lw + 0.6} haloWidth={haloWidth} />
      )}
    </svg>
  );
}

/** The ember art, in two halves, each revealed by its own mask. */
function EmberLayers({
  id,
  level,
  mode,
  box,
  revealWidth,
  haloWidth,
}: {
  id: string;
  level: CordLevel;
  mode: CordMotion;
  box: { x: number; y: number; width: number; height: number };
  revealWidth: number;
  haloWidth: number;
}) {
  const round = { fill: 'none', strokeLinecap: 'round' as const };
  return (
    <>
      <defs>
        <mask id={`${id}o`} maskUnits="userSpaceOnUse" {...box}>
          <path d={CORD_GEO.paths.over} className="pc-cord__o" stroke="#fff" strokeWidth={revealWidth} {...round} />
        </mask>
        <mask id={`${id}u`} maskUnits="userSpaceOnUse" {...box}>
          <path d={CORD_GEO.paths.under} className="pc-cord__u" stroke="#fff" strokeWidth={revealWidth} {...round} />
          {/* The gap around the stem, cut only where the stem has been drawn. */}
          <path d={CORD_GEO.paths.halo} className="pc-cord__h" stroke="#000" strokeWidth={haloWidth} {...round} />
        </mask>
      </defs>
      <g mask={`url(#${id}u)`}>
        <image href={cordArtSrc(level, 'under')} {...box} />
        {mode === 'working' && <Bands part="u" width={CORD_GEO.width[level]} />}
      </g>
      <g mask={`url(#${id}o)`}>
        <image href={cordArtSrc(level)} {...box} />
        {mode === 'working' && <Bands part="o" width={CORD_GEO.width[level]} />}
      </g>
    </>
  );
}

/** The working highlight on one half: three concentric soft bands. */
function Bands({ part, width }: { part: 'o' | 'u'; width: number }) {
  const d = part === 'o' ? CORD_GEO.paths.over : CORD_GEO.paths.under;
  return (
    <>
      {CORD_HIGHLIGHT.bands.map((band, i) => (
        <path
          key={band.dash}
          d={d}
          className={`pc-cord__w${part}${i}`}
          fill="none"
          stroke={CORD_HIGHLIGHT.color}
          strokeOpacity={band.opacity}
          strokeWidth={width}
          strokeDasharray={band.dash}
          // Parked off the cord until the animation places it.
          strokeDashoffset={-CORD_GEO.tot}
        />
      ))}
    </>
  );
}

let observer: IntersectionObserver | null = null;

function offscreenObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      // Test doubles of the observer report entries without a target.
      if (entry.target instanceof Element) entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting);
    }
  });
  return observer;
}

/** Marks the element `data-offscreen` while it is out of view, so its loop holds still. */
function useOffscreenPause<T extends Element>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    const io = active ? offscreenObserver() : null;
    if (!el || !io) return;
    io.observe(el);
    return () => {
      io.unobserve(el);
      el.removeAttribute('data-offscreen');
    };
  }, [active]);
  return ref;
}

/**
 * The inline loading indicator: the flat mark in the text's own color, drawing
 * in and out. For buttons and one-line status rows; section and page loaders
 * use the ember {@link CordMark} at 40-56 px.
 */
export function CordSpinner({ size = 16, className }: { size?: number; className?: string }) {
  return <CordMark size={size} motion="loading" tone="mono" className={className} />;
}
