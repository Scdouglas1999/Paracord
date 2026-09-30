import * as React from 'react';

import { cn } from '../../../lib/utils';
import { TimelineAvatar } from '../../message/TimelineParts';
import { CheckMark } from './CardGlyphs';

/**
 * The plan card (docs/glass-spec.md §3.2): one step above a bubble (`--raise`),
 * radius 20 with the group's joined corner, a title, a time-and-place line, the
 * slots as faces and names, and one decision as text.
 *
 *   Haz 5 run                                       Take the spot
 *   Tonight at 9:30 PM in Lounge
 *   (B) Brendan   (V) Vincent   (L) Luke 10 min   ( ) 1 open
 *
 * Presentational. `EventPlanCard` gives it an event, `PollMessageCard` a poll;
 * neither changes how it looks. Under 340px of card the names hide (a container
 * query in `glass-cards.css`), and the faces stay.
 */

export interface PlanSlotModel {
  key: string;
  /** Shown beside the face, and read by assistive tech either way. */
  name: string;
  /** A second line under the name ("10 min", "Host"). */
  detail?: string;
  /** Who is in this slot. Omitted for an open one. `name` is the person's own name, for their initials, when the slot's label is not it ("You"). */
  face?: { userId: string; avatar?: string | null; name?: string };
  /** The reader: their face wears a light ring. */
  you?: boolean;
  /** Nobody yet: a dashed circle. */
  open?: boolean;
}

export interface PlanCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  /** The time-and-place line under the title. */
  meta?: React.ReactNode;
  /** The decision, top right: a `PlanAction` (or any text button). */
  action?: React.ReactNode;
  slots?: readonly PlanSlotModel[];
  /** Follows a bubble of the same group, so its top corner joins too. */
  joinTop?: boolean;
  /** What the card is, for assistive tech ("Plan", "Poll"). */
  kind?: string;
  /** The whole accessible name, when "kind: title" is not it (a card still loading). */
  label?: string;
  children?: React.ReactNode;
}

function Slot({ slot }: { slot: PlanSlotModel }) {
  return (
    <li className="glass-plan__slot" data-open={slot.open || undefined} data-you={slot.you || undefined}>
      {slot.open || !slot.face ? (
        <span className="glass-plan__open" aria-hidden />
      ) : (
        <TimelineAvatar userId={slot.face.userId} name={slot.face.name ?? slot.name} avatar={slot.face.avatar ?? null} size={28} />
      )}
      {/* The name is hidden under 340px by CSS, so assistive tech gets it here. */}
      <span className="sr-only">{slot.detail ? `${slot.name}, ${slot.detail}` : slot.name}</span>
      <span className="glass-plan__name" aria-hidden>
        <span className="glass-plan__who">{slot.name}</span>
        {slot.detail && <span className="glass-plan__detail">{slot.detail}</span>}
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
      className={cn('glass-plan', className)}
      {...rest}
    >
      <div className="glass-plan__head">
        <span className="glass-plan__text">
          <span className="glass-plan__title">{title}</span>
          {meta && <span className="glass-plan__meta">{meta}</span>}
        </span>
        {action}
      </div>
      {slots && slots.length > 0 && (
        <ul className="glass-plan__slots">
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
 * The card's decision, as text: "Take the spot", and "You're in" with a check
 * once taken. Pressing it again gives the spot back.
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
      className="glass-plan__action glass-focusable"
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
