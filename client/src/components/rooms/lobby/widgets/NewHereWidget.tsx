import { MessageCircle } from 'lucide-react';

import { IconButton } from '../../../ui';
import type { FeedUser } from '../../../../api/serverFeed';
import { displayName } from '../../../../lib/displayName';
import type { Member } from '../../../../types';
import { shortAgo } from '../homeCaptions';
import { FeedAvatar } from '../feedParts';
import { WidgetCard } from './WidgetCard';

export interface NewHereWidgetProps {
  members: readonly Member[] | undefined;
  viewerId: string | null;
  nowMs: number;
  onSayHi: (user: FeedUser) => void;
}

export const NEW_HERE_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;
const SHOWN = 5;

/** Members who joined in the last fourteen days, newest first. */
export function newMembers(members: readonly Member[], nowMs: number): Member[] {
  return members
    .filter((member) => {
      const at = Date.parse(member.joined_at);
      return Number.isFinite(at) && nowMs - at <= NEW_HERE_DAYS * DAY && !member.user.bot;
    })
    .sort((a, b) => Date.parse(b.joined_at) - Date.parse(a.joined_at));
}

/** "New here": who joined lately, each with a way to say hello. */
export function NewHereWidget({ members, viewerId, nowMs, onSayHi }: NewHereWidgetProps) {
  // You know you are new; the list is who else is.
  const fresh = newMembers(members ?? [], nowMs).filter((member) => member.user.id !== viewerId);
  if (fresh.length === 0) return null;
  const shown = fresh.slice(0, SHOWN);
  const rest = fresh.length - shown.length;
  return (
    <WidgetCard title="New here">
      <ul className="flex flex-col gap-2">
        {shown.map((member) => {
          const user: FeedUser = {
            id: member.user.id,
            username: member.user.username,
            display_name: member.user.display_name ?? null,
            avatar_hash: member.user.avatar_hash ?? null,
          };
          const name = displayName(member.user, member.nick);
          return (
            <li key={member.user.id} className="flex items-center gap-2.5">
              <FeedAvatar user={user} size={28} />
              <span className="min-w-0 flex-1 truncate text-label text-text-primary">{name}</span>
              <span className="shrink-0 text-meta text-text-muted">{shortAgo(member.joined_at, nowMs)}</span>
              {member.user.id !== viewerId && (
                <IconButton label={`Say hi to ${name}`} size="sm" onClick={() => onSayHi(user)}>
                  <MessageCircle size={15} aria-hidden />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>
      {rest > 0 && <p className="text-meta text-text-muted">and {rest} more this fortnight</p>}
    </WidgetCard>
  );
}
