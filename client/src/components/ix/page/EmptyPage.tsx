import type { CSSProperties, ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import { IxGlyph, type IxGlyphName } from '../glyphs';

export interface EmptyPageProps {
  /** A glyph in the 76px tile (the tint takes `hue`). */
  glyph?: IxGlyphName;
  /** 24/600: what is true ("This channel is gone"). */
  title: string;
  /** 15, ink-3, one or two sentences: why, and what to do. */
  line?: ReactNode;
  /** The one way forward: a `CreamButton`. */
  action?: ReactNode;
  /** The place's hue for the tile (a number); omit for the window's. */
  hue?: number;
  /** Inside a page's body (the Events page with no events): a block with its own padding, not main's whole height. */
  inline?: boolean;
  /** `alert` for a failure that needs saying now; the default is a plain region. */
  role?: 'alert' | 'status';
  'aria-label'?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * The empty-state layout (docs/index-spec.md §6.8, §4.13): a mark, a 24/600 title,
 * a line, and one cream action, centered in main. It is what "This channel is
 * gone", "This server isn't yours to open", "Couldn't load channels" and the other
 * full-pane notices are made of, so they read as one family with the welcome (the
 * same 76px tile, the same title, the same line).
 *
 * Presentational and unregistered: it does not claim the toolbar, so the frame
 * keeps its tools and pushes the page under it (`data-page="legacy"`).
 */
export function EmptyPage({
  glyph,
  title,
  line,
  action,
  hue,
  inline,
  role,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId = 'ix-empty',
}: EmptyPageProps) {
  // Inside a page the large title is the h1; the notice under it is a section heading, not a second h1.
  const Title = inline ? 'h2' : 'h1';
  return (
    <section
      className={cn('ix-empty', className)}
      role={role}
      aria-label={ariaLabel}
      data-testid={testId}
      data-inline={inline || undefined}
      style={hue === undefined ? undefined : ({ '--ix-hue': hue } as CSSProperties)}
    >
      {glyph && (
        <span className="ix-empty__tile ix-hue-tile" aria-hidden>
          <IxGlyph name={glyph} size={30} />
        </span>
      )}
      <Title className="ix-empty__title">{title}</Title>
      {line && <p className="ix-empty__line">{line}</p>}
      {action && <div className="ix-empty__action">{action}</div>}
    </section>
  );
}
