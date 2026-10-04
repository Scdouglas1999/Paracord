import type { CSSProperties } from 'react';

import { cn } from '../../../lib/utils';
import { Avatar } from './Avatar';

export interface AvatarStackPerson {
  userId: string;
  name: string;
  avatar?: string | null;
}

export interface AvatarStackProps {
  people: readonly AvatarStackPerson[];
  /** Diameter of each face in px. Default 24 (the room card's "and N more"). */
  size?: number;
  /** How far each face after the first is pulled back over the one before it. Default 7. */
  overlap?: number;
  /** Show at most this many faces. Default: all of them. */
  max?: number;
  /** The surface behind the stack as a CSS value (`var(--ix-room-dark)`): the 2px ring that bites the face behind. */
  ring?: string;
  className?: string;
}

/**
 * Faces in a row, each over the one before it (docs/index-spec.md §4.3: up to
 * five 24px faces, -7px overlap, a 2px ring in the card's color). Decorative:
 * the count and the names belong in text beside it.
 */
export function AvatarStack({ people, size = 24, overlap = 7, max, ring, className }: AvatarStackProps) {
  const shown = max === undefined ? people : people.slice(0, max);
  const vars: Record<string, string> = { '--ix-overlap': `${overlap}px` };
  if (ring) vars['--ix-ring'] = ring;
  return (
    <span className={cn('ix-faces', className)} style={vars as CSSProperties} aria-hidden="true">
      {shown.map((person) => (
        <Avatar key={person.userId} userId={person.userId} name={person.name} avatar={person.avatar} size={size} />
      ))}
    </span>
  );
}
