import type { ReactNode, SVGProps } from 'react';

/**
 * The Index glyph set (docs/index-spec.md §2.6): 24x24, stroke 1.7, round caps
 * and joins, drawn in `currentColor`. The paths are the prototype's, verbatim
 * (output/design-reference/index/paracord-index.html), plus the few more the
 * rest of the spec needs (a lock, a podium, a phone) drawn the same way.
 *
 * The verb glyphs the call view keeps (listen, watch, clip, flame, theater) are
 * the Glass paths restroked to 1.7 (§2.6); a solid shape (listen's dot, watch's
 * pupil, the flame's ember) has no stroke.
 *
 * Size is a prop in px; the stroke scales with the glyph, as in the prototype.
 * The default is the prototype's 18; the sizes in use are 12 (lock), 14 (chip
 * glyphs, a row's state), 15 (search), 16 (rooms, controls) and 18.
 */
export const IX_GLYPH_NAMES = [
  'speaker',
  'mic',
  'micOff',
  'camera',
  'screen',
  'x',
  'search',
  'people',
  'dots',
  'invite',
  'plan',
  'hello',
  'attach',
  'poll',
  'event',
  'send',
  'plus',
  'chevron',
  'check',
  'lock',
  'megaphone',
  'stage',
  'phone',
  'listen',
  'watch',
  'clip',
  'flame',
  'theater',
] as const;
export type IxGlyphName = (typeof IX_GLYPH_NAMES)[number];

/** A solid shape: filled, not stroked. */
const SOLID = { fill: 'currentColor', stroke: 'none' } as const;

const BODIES: Record<IxGlyphName, ReactNode> = {
  speaker: (
    <>
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  micOff: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      <path d="M4 4l16 16" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="m16 10.5 5-3v9l-5-3z" />
    </>
  ),
  screen: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.8 3.3-6 6.5-6s5.9 2.2 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .6 3.3 2.6 3.5 6" />
    </>
  ),
  dots: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </>
  ),
  invite: <path d="M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 8v6M23 11h-6" />,
  plan: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  hello: <path d="M4 5h16v11H9l-5 4z" />,
  attach: <path d="M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19" />,
  poll: <path d="M5 20V10M12 20V4M19 20v-7" />,
  event: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
    </>
  ),
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  check: <path d="M5 12.5 9.5 17 19 7.5" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 14v-4l12-5v14z" />
      <path d="m7 14 1.5 5h3L10 15M19.5 9.5v5" />
    </>
  ),
  stage: (
    <>
      <circle cx="12" cy="5.5" r="2.5" />
      <path d="M7 20v-7.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V20M4 20h16" />
    </>
  ),
  phone: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z" />,
  listen: (
    <>
      <circle cx="5.5" cy="12" r="1.6" {...SOLID} />
      <path d="M9.5 8.8a4.6 4.6 0 0 1 0 6.4M13.4 5.9a8.8 8.8 0 0 1 0 12.2M17.3 3a13 13 0 0 1 0 18" />
    </>
  ),
  watch: (
    <>
      <path d="M2.8 12c2.6-4.3 5.7-6.4 9.2-6.4s6.6 2.1 9.2 6.4c-2.6 4.3-5.7 6.4-9.2 6.4S5.4 16.3 2.8 12z" />
      <circle cx="12" cy="12" r="2.7" {...SOLID} />
    </>
  ),
  clip: (
    <>
      <rect x="3.5" y="4.5" width="17" height="13" rx="3" />
      <path d="M15.2 4.5h2.3a3 3 0 0 1 3 3v2.3z" fill="currentColor" />
      <path d="M9 21h6" />
      <path d="M8 8.5v5M11 8.5v5" />
    </>
  ),
  flame: (
    <>
      <path d="M12 2.8c.7 3.3 5.2 5 5.2 10.1a5.2 5.2 0 0 1-10.4 0c0-2.2 1-3.6 2.3-4.7.1 2.1 1.1 3.2 2.4 3.6-.6-3-.9-6.1.5-9z" />
      <path d="M12 19.6c1.2 0 2-.9 2-2 0-1.5-1.2-2.3-2-3.5-.8 1.2-2 2-2 3.5 0 1.1.8 2 2 2z" {...SOLID} />
    </>
  ),
  theater: (
    <>
      <rect x="3" y="3.5" width="18" height="11.5" rx="1.6" />
      <path d="M5 20.5a1.6 1.6 0 0 1 3.2 0M10.4 20.5a1.6 1.6 0 0 1 3.2 0M15.8 20.5a1.6 1.6 0 0 1 3.2 0" />
    </>
  ),
};

export interface GlyphFrameProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  /** Pixel size (square). The glyph is drawn on a 24 grid and scales with its stroke. Default 18. */
  size?: number;
  /**
   * An accessible name. Without one the glyph is decorative (`aria-hidden`),
   * the right default inside a button that already carries a label.
   */
  title?: string;
  children?: ReactNode;
}

/**
 * The frame every glyph is drawn in: a 24 grid, stroke 1.7, round caps and
 * joins, `currentColor`. Use it for a one-off glyph that is not in the set, so
 * it matches the rest: `<GlyphFrame size={16}><path d="…" /></GlyphFrame>`.
 */
export function GlyphFrame({ size = 18, title, style, className, children, ...rest }: GlyphFrameProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={className ? `ix-glyph ${className}` : 'ix-glyph'}
      style={style}
      {...rest}
    >
      {children}
    </svg>
  );
}

export interface IxGlyphProps extends Omit<GlyphFrameProps, 'children'> {
  name: IxGlyphName;
}

/** One glyph of the Index set by name. */
export function IxGlyph({ name, ...rest }: IxGlyphProps) {
  return (
    <GlyphFrame data-glyph={name} {...rest}>
      {BODIES[name]}
    </GlyphFrame>
  );
}
