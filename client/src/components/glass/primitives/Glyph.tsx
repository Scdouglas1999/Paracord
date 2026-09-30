import * as React from 'react';

/**
 * Paracord's own verbs (docs/glass-spec.md §2.5): 24x24, 2px stroke, round caps
 * and joins, drawn in `currentColor`. Stock icons (search, people, plus, mic,
 * camera, share, close) stay lucide; these six are ours.
 *
 * The paths are the spec's, verbatim. A "fill" in the spec is a solid shape
 * with no stroke (listen's dot, watch's pupil, the flame's ember) except the
 * clip's corner, which keeps its stroke.
 */
export const GLYPH_NAMES = ['listen', 'watch', 'clip', 'flame', 'theater', 'split'] as const;
export type GlyphName = (typeof GLYPH_NAMES)[number];

const SOLID = { fill: 'currentColor', stroke: 'none' } as const;

const GLYPH_BODIES: Record<GlyphName, React.ReactNode> = {
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
  split: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M15 5v14" />
    </>
  ),
};

export interface GlyphProps extends Omit<React.SVGProps<SVGSVGElement>, 'name' | 'ref'> {
  name: GlyphName;
  /** Pixel size (square). The glyph is drawn on a 24 grid and scales. */
  size?: number;
  /**
   * An accessible name. Without one the glyph is decorative (`aria-hidden`), the
   * right default inside a button that already carries a label.
   */
  title?: string;
}

/**
 * One of the six Paracord glyphs. The stroke stays 2 in the 24 grid, so it
 * scales with the icon (a 13px glyph draws a ~1.1px line, as in the reference).
 */
export function Glyph({ name, size = 24, title, style, ...rest }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      data-glyph={name}
      style={{ flexShrink: 0, ...style }}
      {...rest}
    >
      {GLYPH_BODIES[name]}
    </svg>
  );
}

type NamedGlyphProps = Omit<GlyphProps, 'name'>;

export const ListenGlyph = (props: NamedGlyphProps) => <Glyph name="listen" {...props} />;
export const WatchGlyph = (props: NamedGlyphProps) => <Glyph name="watch" {...props} />;
export const ClipGlyph = (props: NamedGlyphProps) => <Glyph name="clip" {...props} />;
export const FlameGlyph = (props: NamedGlyphProps) => <Glyph name="flame" {...props} />;
export const TheaterGlyph = (props: NamedGlyphProps) => <Glyph name="theater" {...props} />;
export const SplitGlyph = (props: NamedGlyphProps) => <Glyph name="split" {...props} />;
