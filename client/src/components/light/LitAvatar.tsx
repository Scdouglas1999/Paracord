import * as React from 'react';

import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { useAuthenticatedImage } from '../../lib/authenticatedImage';
import { getIdentityColor } from '../../lib/colors';
import { resolveUserAvatarUrl } from '../../lib/userAvatar';
import { cn } from '../../lib/utils';
import type { PersonLight } from '../../lib/attention/light';
import { LIT_MARK, PERSON_MARK, RIM_MARK, ROOM_MARK } from '../../lib/motion';

/** Initials for the fallback chip — at most two letters, never an emoji. */
export function avatarInitials(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

export interface LitAvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  person: PersonLight;
  /** Diameter in px. The reference renders use 18, 22, 24, 26, 28, 32 and 36. */
  size?: number;
  /**
   * Render the person's name for assistive tech. Off when the avatar sits in a
   * stack that already names everybody (an `AvatarStack` labels itself), on
   * everywhere else — light is never the only cue (§9).
   */
  hideLabel?: boolean;
  /**
   * The room this face is standing in, when the surface knows it.
   *
   * Purely a motion mark: "lights on" brings a person's rim up 120ms after the
   * room they are in (§5.1), and without this the engine has no way to know
   * which window is theirs. A face with no room simply follows the last one.
   */
  room?: string | null;
}

/**
 * LitAvatar — a person, as light (docs/lantern-stage-spec.md §1.5, §5, §8).
 *
 *   lights on  → a warm rim (`pc-lit`)
 *   speaking   → the rim breathes between alpha .55 and .8 at ~1.6s (`pc-speaking`)
 *   away / dnd → matte, no rim (`pc-dim`), plus a danger slash for dnd
 *   lights off → matte, no rim
 *
 * The rim is state, never style: if this avatar glows, that person has the app
 * open right now. Motion and `prefers-reduced-motion` are handled centrally in
 * `src/styles/primitives.css` — there is no motion code in this component.
 */
export const LitAvatar = React.forwardRef<HTMLSpanElement, LitAvatarProps>(function LitAvatar(
  { person, size = 28, hideLabel = false, room = null, className, style, ...props },
  ref,
) {
  // The avatar URL carries the server's download ticket, which is minted after
  // the first paint; without this the face stays a broken image all session.
  useDownloadTicket();
  const src = useAuthenticatedImage(resolveUserAvatarUrl(person.avatar));
  const dimension = { width: size, height: size };
  const face = (
    <span
      // The rim glow lives on this element, so this is the one that blooms and
      // dims — the outer span is the thing that MOVES (§5.1).
      {...{ [RIM_MARK]: '' }}
      className={cn(
        person.avatarClass,
        'pc-display pc-dimming relative flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        'font-bold text-text-on-light',
      )}
      style={{
        ...dimension,
        fontSize: Math.max(7, Math.round(size * 0.36)),
        background: src ? undefined : getIdentityColor(person.userId),
      }}
      aria-hidden
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        avatarInitials(person.name)
      )}
    </span>
  );

  return (
    <span
      ref={ref}
      {...{ [PERSON_MARK]: person.userId }}
      {...(person.lit ? { [LIT_MARK]: '' } : null)}
      {...(room ? { [ROOM_MARK]: room } : null)}
      className={cn(
        'relative inline-flex shrink-0 rounded-full',
        person.dnd && 'pc-dnd',
        className,
      )}
      style={{ ...dimension, ...style }}
      {...props}
    >
      {face}
      {!hideLabel && (
        <span className="sr-only">
          {person.name} — {person.label}
        </span>
      )}
    </span>
  );
});
