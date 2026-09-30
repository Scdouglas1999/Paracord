import { memo, useMemo } from 'react';

import { GlassButton } from '../../glass/primitives';
import { FaceStack } from '../../glass/places/Lead';
import type { FeedMembersJoinedItem, FeedUser } from '../../../api/serverFeed';
import { displayName } from '../../../lib/displayName';
import { joinedLine } from './homeCaptions';

export interface FeedItemMembersJoinedProps {
  item: FeedMembersJoinedItem;
  when: string;
  /** Null for the viewer themselves: nobody says hi to themselves. */
  onSayHi: ((user: FeedUser) => void) | null;
  viewerId: string | null;
}

/**
 * The people who joined on one day, as one line, not a card: it is something that
 * happened, not something somebody made. "Say hi" opens a direct message with the
 * first person it names.
 */
export const FeedItemMembersJoined = memo(function FeedItemMembersJoined({ item, when, onSayHi, viewerId }: FeedItemMembersJoinedProps) {
  const faces = useMemo(
    () => item.users.map((user) => ({ userId: user.id, name: displayName(user), avatar: user.avatar_hash ?? null })),
    [item.users],
  );
  const names = item.users.map((user) => displayName(user));
  const greet = item.users.find((user) => user.id !== viewerId) ?? null;
  const line = joinedLine(names, item.total);

  return (
    <article aria-label={line} className="glass-happened">
      <FaceStack faces={faces.slice(0, 4)} size={28} overlap={8} />
      <p className="glass-happened__text">
        <strong>{line}</strong>
        {when && <span className="glass-instrument text-[var(--ink-3)]"> · {when}</span>}
      </p>
      {greet && onSayHi && (
        <GlassButton variant="text" onClick={() => onSayHi(greet)} aria-label={`Say hi to ${displayName(greet)}`}>
          Say hi
        </GlassButton>
      )}
    </article>
  );
});
