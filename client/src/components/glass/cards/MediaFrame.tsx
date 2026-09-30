import * as React from 'react';

import { cn } from '../../../lib/utils';
import { InstrumentText } from '../primitives';
import { FileMark } from './CardGlyphs';

/**
 * A picture in the timeline (docs/glass-spec.md §3.2): radius 20 with the
 * group's joined corner, a soft shadow and no outline, 240px wide (the
 * reference's 240 x 135 for a 16:9 picture), and no footer. What the old
 * footer offered is still one gesture away:
 *
 *   Open       press the picture (the lightbox, which also downloads)
 *   Download   the tools that appear over its corner on hover or focus, and
 *              always on a touch screen, where there is no hover
 *   Delete     the same tools, on your own pictures
 *
 * The frame clips its picture; the host around it does not, so the reactions
 * chip can bite the corner (`bite`) and the tools sit inside it.
 */

export interface GlassMediaProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Follows something in the same group (a bubble, another picture), so the top corner joins too. */
  joinTop?: boolean;
  /** The picture's own size when the server knows it, so the frame holds its shape while it loads. */
  width?: number;
  height?: number;
  /** A small label in the top corner ("Federated"). */
  badge?: React.ReactNode;
  /** Icon buttons over the bottom corner: `MediaTool`s. */
  tools?: React.ReactNode;
  /** The reactions chip, biting the top-right corner. */
  bite?: React.ReactNode;
}

export const GlassMedia = React.forwardRef<HTMLDivElement, GlassMediaProps>(function GlassMedia(
  { joinTop, width, height, badge, tools, bite, className, children, ...rest },
  ref,
) {
  const shaped = width && height ? { aspectRatio: `${width} / ${height}` } : undefined;
  return (
    <div
      ref={ref}
      className={cn('glass-media', className)}
      data-join-top={joinTop || undefined}
      data-bitten={Boolean(bite) || undefined}
      {...rest}
    >
      <div className="glass-media__frame" style={shaped} data-shaped={shaped ? '' : undefined}>
        {children}
        {badge && <span className="glass-media__badge">{badge}</span>}
      </div>
      {tools && <div className="glass-media__tools">{tools}</div>}
      {bite}
    </div>
  );
});

/** A round icon button over a picture. Near-solid, so it reads on any picture. */
export function MediaTool({
  label,
  onClick,
  disabled,
  busy,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Something is in flight (a download's percentage): shown as the tooltip. */
  busy?: string | null;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="glass-media__tool glass-focusable"
      aria-label={label}
      title={busy ?? label}
      aria-busy={busy ? true : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * A file that is not a picture (or a picture with previews off): a solid card
 * shaped like a bubble, the file's name and size, and its actions as text.
 */
export function GlassFile({
  name,
  size,
  note,
  badge,
  joinTop,
  actions,
  onOpen,
  className,
}: {
  name: string;
  /** "97.7 KB". */
  size?: string | null;
  /** A quiet remark ("Preview off"). */
  note?: string;
  badge?: React.ReactNode;
  joinTop?: boolean;
  actions?: React.ReactNode;
  /** Pressing the name does this (a file's name downloads it). Plain text when omitted. */
  onOpen?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('glass-file', className)} data-join-top={joinTop || undefined}>
      <span className="glass-file__icon" aria-hidden>
        <FileMark />
      </span>
      <span className="glass-file__text">
        {onOpen ? (
          <button type="button" className="glass-file__name glass-file__name--button glass-focusable" title={name} onClick={onOpen}>
            {name}
          </button>
        ) : (
          <span className="glass-file__name" title={name}>
            {name}
          </span>
        )}
        <span className="glass-file__line">
          {size && <InstrumentText>{size}</InstrumentText>}
          {note && <span>{note}</span>}
          {badge}
        </span>
      </span>
      {actions && <span className="glass-file__actions">{actions}</span>}
    </div>
  );
}
