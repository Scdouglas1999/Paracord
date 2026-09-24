import * as React from 'react';

import { RollingNumber } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { nameList, type PersonLight } from '../../lib/attention/light';
import { STRIP_MARK } from '../../lib/motion';
import { LitAvatar } from './LitAvatar';

export interface AvatarStackProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  people: readonly PersonLight[];
  /** Diameter in px; the overlap scales with it. */
  size?: number;
  /** How many faces before the "+M" chip. The reference renders use 3–5. */
  max?: number;
  /** Overlap in px. Defaults to a quarter of `size`, as in the reference. */
  overlap?: number;
  /** What the group is — "in Shop floor", "reading build-log". */
  context?: string;
  /** The room these faces are in, when the surface knows it — a motion mark. */
  room?: string | null;
  /** Wrap each face, e.g. in a tooltip saying who it is and what they are up to. */
  renderFace?: (person: PersonLight, face: React.ReactElement) => React.ReactNode;
}

/**
 * AvatarStack — overlapping lit faces with a "+M" tail
 * (docs/lantern-stage-spec.md §8: occupant stacks, reader stacks, the here-now
 * strip).
 *
 * The stack names everybody once, in one `sr-only` sentence, rather than
 * letting each avatar announce itself — a row of six screen-reader labels is
 * noise. §9 is satisfied by that sentence, so it is never optional.
 */
export const AvatarStack = React.forwardRef<HTMLSpanElement, AvatarStackProps>(
  function AvatarStack(
    { people, size = 24, max = 5, overlap, context, room = null, renderFace, className, ...props },
    ref,
  ) {
    const shown = people.slice(0, max);
    const rest = people.length - shown.length;
    const step = overlap ?? Math.round(size / 4);
    const sentence = people.length
      ? `${nameList(people.map((person) => person.name), Math.max(3, max))}${context ? ` ${context}` : ''}`
      : '';

    return (
      <span
        ref={ref}
        // A stack is where a face springs in from and slides out of (§5.1).
        {...{ [STRIP_MARK]: '' }}
        className={cn('inline-flex shrink-0 items-center', className)}
        {...props}
      >
        {shown.map((person, index) => {
          const face = (
            <LitAvatar
              key={person.userId}
              person={person}
              size={size}
              room={room}
              hideLabel
              style={index === 0 || renderFace ? undefined : { marginLeft: -step }}
            />
          );
          if (!renderFace) return face;
          // The wrapper takes the overlap so whatever wraps the face (a
          // tooltip's hover target) lines up with the face itself.
          return (
            <span
              key={person.userId}
              className="relative inline-flex shrink-0"
              style={index === 0 ? undefined : { marginLeft: -step }}
            >
              {renderFace(person, face)}
            </span>
          );
        })}
        {rest > 0 && (
          <span
            className={cn(
              'pc-display relative inline-flex shrink-0 items-center justify-center rounded-full',
              'bg-bg-raised font-semibold text-text-secondary shadow-[var(--shadow-chip)]',
            )}
            style={{
              width: size,
              height: size,
              marginLeft: -step,
              fontSize: Math.max(8, Math.round(size * 0.34)),
            }}
            aria-hidden
          >
            {/* The tail counts the faces that did not fit, so it changes every
                time somebody arrives or leaves — §5.1, it re-rolls. The stack's
                own sentence below is what a screen reader hears. */}
            <RollingNumber value={rest} format={(count) => `+${count}`} announce={false} />
          </span>
        )}
        {sentence && <span className="sr-only">{sentence}</span>}
      </span>
    );
  },
);
