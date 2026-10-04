import * as React from 'react';

import { cn } from '../../../lib/utils';
import { Avatar } from '../../ix/identity/Avatar';
import { CheckMark } from './CardGlyphs';

/**
 * A titled card of the event-card family (docs/index-spec.md §3.1, §4.11): the
 * `--ix-card` surface, radius 20, padding 16, a 16/700 title and a 13.5 line
 * under it. It is the shell of a poll (the options are its children) and of any
 * card that has a title and a line and has not got a calendar tile; the event in
 * a message is `EventCard`.
 *
 *   Late one after the run?
 *   Pick one · 12 votes · ends Fri
 *   ...children...
 *
 * Presentational. With `slots` it still draws the faces-and-names row the Home
 * and server pages use (docs/glass-spec.md §3.2), in the same card.
 */

export interface PlanSlotModel {
  key: string;
  /** Shown beside the face, and read by assistive tech either way. */
  name: string;
  /** A second line under the name ("10 min", "Host"). */
  detail?: string;
  /** Who is in this slot. Omitted for an open one. `name` is the person's own name, for their letter, when the slot's label is not it ("You"). */
  face?: { userId: string; avatar?: string | null; name?: string };
  /** The reader: their face wears a light ring. */
  you?: boolean;
  /** Nobody yet: a dashed circle. */
  open?: boolean;
}

export interface PlanCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  /** The line under the title. */
  meta?: React.ReactNode;
  /** The decision, top right: a `PlanAction` (or any text button). */
  action?: React.ReactNode;
  slots?: readonly PlanSlotModel[];
  /** Follows a bubble of the same group; kept as a hook for the timeline (`data-join-top`). */
  joinTop?: boolean;
  /** What the card is, for assistive tech ("Plan", "Poll"). */
  kind?: string;
  /** The whole accessible name, when "kind: title" is not it (a card still loading). */
  label?: string;
  children?: React.ReactNode;
}

function Slot({ slot }: { slot: PlanSlotModel }) {
  return (
    <li className="ix-plan__slot" data-open={slot.open || undefined} data-you={slot.you || undefined}>
      {slot.open || !slot.face ? (
        <span className="ix-plan__open" aria-hidden />
      ) : (
        <Avatar userId={slot.face.userId} name={slot.face.name ?? slot.name} avatar={slot.face.avatar ?? null} size={28} />
      )}
      {/* The name is hidden under 340px by CSS, so assistive tech gets it here. */}
      <span className="sr-only">{slot.detail ? `${slot.name}, ${slot.detail}` : slot.name}</span>
      <span className="ix-plan__name" aria-hidden>
        <span className="ix-plan__who">{slot.name}</span>
        {slot.detail && <span className="ix-plan__detail">{slot.detail}</span>}
      </span>
    </li>
  );
}

export function PlanCard({
  title,
  meta,
  action,
  slots,
  joinTop,
  kind = 'Plan',
  label,
  className,
  children,
  ...rest
}: PlanCardProps) {
  return (
    <div
      role="group"
      aria-label={label ?? (typeof title === 'string' ? `${kind}: ${title}` : kind)}
      data-join-top={joinTop || undefined}
      className={cn('ix-card ix-plan', className)}
      {...rest}
    >
      <div className="ix-plan__head">
        <span className="ix-plan__text">
          <span className="ix-plan__title">{title}</span>
          {meta && <span className="ix-plan__meta">{meta}</span>}
        </span>
        {action}
      </div>
      {slots && slots.length > 0 && (
        <ul className="ix-plan__slots">
          {slots.map((slot) => (
            <Slot key={slot.key} slot={slot} />
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}

/**
 * The card's decision, as a quiet button: "Take the spot", and "You're in" with
 * a check once taken. Pressing it again gives the spot back.
 */
export function PlanAction({
  taken,
  busy,
  onToggle,
  takeLabel = 'Take the spot',
  takenLabel = 'You’re in',
}: {
  taken: boolean;
  busy?: boolean;
  onToggle: () => void;
  takeLabel?: string;
  takenLabel?: string;
}) {
  return (
    <button
      type="button"
      className="ix-plan__action"
      data-taken={taken || undefined}
      // The words it shows are the words it is called (the check is decoration).
      aria-label={taken ? takenLabel : takeLabel}
      disabled={busy}
      onClick={onToggle}
    >
      {taken && <CheckMark />}
      {taken ? takenLabel : takeLabel}
    </button>
  );
}
