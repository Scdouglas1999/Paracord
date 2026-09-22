import { useMemo } from 'react';
import { MessageCircle } from 'lucide-react';

import { AvatarStack } from '../../light';
import { Button } from '../../ui';
import type { FeedMembersJoinedItem, FeedUser } from '../../../api/serverFeed';
import { personLight } from '../../../lib/attention/personLight';
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
 * The people who joined on one day, as one line. "Say hi" opens a direct
 * message with the first person it names.
 */
export function FeedItemMembersJoined({ item, when, onSayHi, viewerId }: FeedItemMembersJoinedProps) {
  const people = useMemo(
    () =>
      item.users.map((user) =>
        personLight({ userId: user.id, name: displayName(user), status: null, avatar: user.avatar_hash }),
      ),
    [item.users],
  );
  const names = item.users.map((user) => displayName(user));
  const greet = item.users.find((user) => user.id !== viewerId) ?? null;

  return (
    <article
      aria-label={joinedLine(names, item.total)}
      className="flex min-w-0 items-center gap-3 rounded-[var(--radius-card)] px-4 py-3 shadow-[inset_0_0_0_1px_var(--border-subtle)]"
    >
      <AvatarStack people={people} size={28} max={4} context="joined" />
      <p className="min-w-0 flex-1 truncate text-label text-text-secondary">
        <span className="text-text-primary">{joinedLine(names, item.total)}</span>
        {when && <span className="text-text-muted"> · {when}</span>}
      </p>
      {greet && onSayHi && (
        <Button variant="ghost" size="sm" onClick={() => onSayHi(greet)} className="shrink-0" aria-label={`Say hi to ${displayName(greet)}`}>
          <MessageCircle size={14} aria-hidden />
          Say hi
        </Button>
      )}
    </article>
  );
}
