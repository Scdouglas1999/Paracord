import * as React from 'react';
// §5.1 "plates settle": a plate mounting into an already-rendered street
// rises 14px on the spring-settle; the first paint of the app is exempt
// (WP9b owns lights-on). The engine's hook decides which case a mount is.
import { useSettleIn } from '../../lib/motion';
import { cn, mergeRefs } from '../../lib/utils';

export interface PlateProps extends React.HTMLAttributes<HTMLElement> {
  /**
   * Render as a different element (`section`, `aside`, `main`, `article`, …).
   * A plate is a surface, not a semantic — pick the tag the content deserves.
   */
  as?: 'div' | 'section' | 'article' | 'aside' | 'main' | 'header' | 'footer' | 'nav';
  /**
   * The plate's room is live: adds the lit ring on top of the plate shadow.
   * Light is state, never style — pass this only when somebody is in there
   * right now, and render the text equivalent alongside (spec §9).
   */
  lit?: boolean;
  /** Drop the plate's own padding when the caller lays the inside out itself. */
  bare?: boolean;
}

/**
 * A plate (spec §1.1, §4): the surface that holds content — the Stage, the
 * Lobby, a text room, the chat ribbon, a card. Depth is a 1px warm top
 * highlight plus a deep shadow, never a border.
 *
 * Never nest a plate in a plate. Inside a plate you get one more step: a
 * {@link Well} (recessed) or a raised row/card. That is the whole elevation
 * system.
 */
export const Plate = React.forwardRef<HTMLElement, PlateProps>(function Plate(
  { as = 'div', lit = false, bare = false, className, children, ...props },
  ref,
) {
  const Tag = as as React.ElementType;
  const settleRef = useSettleIn<HTMLElement>();
  return (
    <Tag
      ref={mergeRefs(ref, settleRef)}
      className={cn('pc-plate', lit && 'is-lit', !bare && 'p-4', className)}
      {...props}
    >
      {children}
    </Tag>
  );
});

export interface LampProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Lamp width in px. Defaults to the reference render's 140×80 top-left lamp. */
  width?: number;
  /** Lamp height in px. */
  height?: number;
}

/* A caller that needs the lamp sized to its surface rather than in pixels
   overrides `left/top/width/height` through `style` — the defaults below are
   merged first, so a percentage box wins (see RoomThumbnail). */

/**
 * The one permitted radial (spec §1.2): a lamp inside a lit building or room
 * card, anchored near its top-left. One per lit card, and never on a surface
 * whose room is dark. Render it as the first child of a `relative overflow-hidden`
 * plate or card.
 */
export const Lamp = React.forwardRef<HTMLSpanElement, LampProps>(function Lamp(
  { width = 140, height = 80, className, style, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      aria-hidden
      className={cn('pc-lamp', className)}
      style={{ left: 20, top: -20, width, height, ...style }}
      {...props}
    />
  );
});
