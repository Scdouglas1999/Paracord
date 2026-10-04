import * as React from 'react';

import { cn } from '../../../lib/utils';
import { CreamButton } from '../../ix/primitives/CreamButton';
import { CheckMark } from './CardGlyphs';

/**
 * The event card (docs/index-spec.md §3.1, §4.11; the prototype's `.event`): a
 * calendar tile, the title, "Friday at 9:00 PM · in General", and one row of
 * actions. It is presentational: `EventPlanCard` gives it an event from the
 * server, and the empty channel's "Plan a night" gives it a draft ("Post it" /
 * "Edit", docs/index-spec.md §4.13).
 *
 *   ┌────────────────────────────────────────┐
 *   │ ┌────┐  Game night                      │
 *   │ │FRI │  Friday at 9:00 PM · in General  │
 *   │ │ 9  │                                  │
 *   │ └────┘                                  │
 *   │ [ I'm in ] [ Maybe ]                    │
 *   └────────────────────────────────────────┘
 *
 * The tile is decoration (the sentence under the title says the same), so it is
 * hidden from assistive tech. The weekday takes the place's hue (`--ix-hue`).
 */
export interface EventCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The tile's short weekday ("Fri"). Set in capitals by CSS, the one place the product does. */
  weekday: string;
  /** The tile's day of the month. */
  day: string;
  title: React.ReactNode;
  /** "Friday at 9:00 PM · in General". */
  meta?: React.ReactNode;
  /** What the card is, for assistive tech ("Event"). */
  kind?: string;
  /** The whole accessible name, when "kind: title" is not it. */
  label?: string;
  /** Not on the calendar any more: dims the tile and the title. */
  tone?: 'live' | 'over' | 'canceled';
  /** Follows a bubble of the same group; kept as a hook for the timeline (`data-join-top`). */
  joinTop?: boolean;
  /** The action row: `EventButton`s. Omit it for a card with nothing to do. */
  children?: React.ReactNode;
}

export function EventCard({
  weekday,
  day,
  title,
  meta,
  kind = 'Event',
  label,
  tone,
  joinTop,
  className,
  children,
  ...rest
}: EventCardProps) {
  return (
    <div
      role="group"
      aria-label={label ?? (typeof title === 'string' ? `${kind}: ${title}` : kind)}
      data-join-top={joinTop || undefined}
      data-tone={tone}
      className={cn('ix-card ix-event', className)}
      {...rest}
    >
      <div className="ix-event__day ix-hue-weekday" aria-hidden>
        <small>{weekday}</small>
        <b>{day}</b>
      </div>
      <p className="ix-event__title">{title}</p>
      {meta && <p className="ix-event__meta">{meta}</p>}
      {children && <div className="ix-event__acts">{children}</div>}
    </div>
  );
}

export interface EventButtonProps extends Omit<React.ComponentPropsWithRef<'button'>, 'children'> {
  /** The one cream button on the card ("I'm in", "Post it"). */
  primary?: boolean;
  /** A chosen state of a two-way button ("Maybe", "You're in"): the quiet fill takes a lit edge. */
  pressed?: boolean;
  /** A check before the words (a choice made). */
  check?: boolean;
  children: React.ReactNode;
}

/**
 * An action on an event card: cream for the one primary, a quiet fill for the
 * rest (13.5/600, padding 8 12, radius 10).
 */
export function EventButton({ primary, pressed, check, type = 'button', className, children, ...rest }: EventButtonProps) {
  if (primary) {
    return (
      <CreamButton size="sm" type={type} className={className} {...rest}>
        {check && <CheckMark />}
        {children}
      </CreamButton>
    );
  }
  return (
    <button
      type={type}
      className={cn('ix-event__btn', className)}
      data-pressed={pressed || undefined}
      {...rest}
    >
      {check && <CheckMark />}
      {children}
    </button>
  );
}
