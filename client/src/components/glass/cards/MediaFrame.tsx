import * as React from 'react';

import { cn } from '../../../lib/utils';
import { FileMark } from './CardGlyphs';

/**
 * A picture or a clip in the timeline: a media bubble (docs/index-spec.md
 * §4.11). No padding, radius 19 with the group's joined corners on the
 * author's side, fitted inside 360×360, no footer. What a footer would offer is
 * one gesture away:
 *
 *   Open       press the picture (the media viewer, which also downloads)
 *   Download   the tools over its bottom corner on hover or focus, and always
 *              on a touch screen, where there is no hover
 *   Delete     the same tools, on your own pictures
 *
 * The frame clips its picture; the host around it does not, so the reactions
 * chip can bite the corner (`bite`) and the tools sit inside it.
 */

/** The media bubble's box (§4.11): fitted inside this square. */
export const MEDIA_MAX = 360;

export interface GlassMediaProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Follows something in the same group (a bubble, another picture): the top corner on the author's side joins. */
  joinTop?: boolean;
  /** Something in the same group follows it: the bottom corner on the author's side joins. */
  joinBottom?: boolean;
  /** The picture's own size when the server knows it, so the frame holds its shape while it loads. */
  width?: number;
  height?: number;
  /** A small label in the top corner ("Federated"). */
  badge?: React.ReactNode;
  /** Icon buttons over the bottom corner: `MediaTool`s. */
  tools?: React.ReactNode;
  /** The reactions chip, biting the top trailing corner. */
  bite?: React.ReactNode;
}

/** The size a picture is drawn at: its own, fitted inside 360×360. */
export function fitMedia(width?: number, height?: number): { width: number; height: number } | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, MEDIA_MAX / width, MEDIA_MAX / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export const GlassMedia = React.forwardRef<HTMLDivElement, GlassMediaProps>(function GlassMedia(
  { joinTop, joinBottom, width, height, badge, tools, bite, className, children, style, ...rest },
  ref,
) {
  const fitted = fitMedia(width, height);
  return (
    <div
      ref={ref}
      className={cn('ix-media', className)}
      data-join-top={joinTop || undefined}
      data-join-bottom={joinBottom || undefined}
      data-bitten={Boolean(bite) || undefined}
      style={style}
      {...rest}
    >
      <div
        className="ix-media__frame"
        style={fitted ? { width: fitted.width, aspectRatio: `${fitted.width} / ${fitted.height}` } : undefined}
        data-shaped={fitted ? '' : undefined}
      >
        {children}
        {badge && <span className="ix-media__badge">{badge}</span>}
      </div>
      {tools && <div className="ix-media__tools">{tools}</div>}
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
      className="ix-media__tool"
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
 * A file that is not a picture (or a picture with previews off): a card bubble
 * (§4.11) on `--ix-card`, a 38px glyph tile in the place's hue, the name, the
 * size, and its actions as text.
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
  /** Kept for callers; a card's corners never join (§2.5). */
  joinTop?: boolean;
  actions?: React.ReactNode;
  /** Pressing the name does this (a file's name downloads it). Plain text when omitted. */
  onOpen?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('ix-file ix-file--timeline', className)} data-join-top={joinTop || undefined}>
      <span className="ix-file__tile" aria-hidden>
        <FileMark />
      </span>
      <span className="ix-file__text">
        {onOpen ? (
          <button type="button" className="ix-file__name ix-file__name--button" title={name} onClick={onOpen}>
            {name}
          </button>
        ) : (
          <span className="ix-file__name" title={name}>
            {name}
          </span>
        )}
        <span className="ix-file__size">
          {[size, note].filter(Boolean).join(' · ')}
          {badge && <span className="ix-file__badge">{badge}</span>}
        </span>
      </span>
      {actions && <span className="ix-file__actions">{actions}</span>}
    </div>
  );
}
