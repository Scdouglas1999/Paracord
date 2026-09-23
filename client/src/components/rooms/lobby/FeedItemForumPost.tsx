import { memo, useMemo } from 'react';

import { AvatarStack } from '../../light';
import type { FeedForumPostItem } from '../../../api/serverFeed';
import { personLight } from '../../../lib/attention/personLight';
import { displayName } from '../../../lib/displayName';
import { stripMarkdown } from '../../../lib/markdown';
import { cn } from '../../../lib/utils';
import { FeedAvatar, FeedCardHeader } from './feedParts';
import { repliesLine, shortAgo } from './homeCaptions';

export interface FeedItemForumPostProps {
  item: FeedForumPostItem;
  when: string;
  nowMs: number;
  onOpen: () => void;
  /** A phone: no avatar column, so the title and text take the full width. */
  compact?: boolean;
}

/**
 * A forum post: its title, the start of what was asked, how many replies it
 * has, who answered last and who has joined in. The whole card opens the post.
 */
export const FeedItemForumPost = memo(function FeedItemForumPost({ item, when, nowMs, onOpen, compact = false }: FeedItemForumPostProps) {
  const participants = useMemo(
    () =>
      item.participants.map((user) =>
        personLight({ userId: user.id, name: displayName(user), status: null, avatar: user.avatar_hash }),
      ),
    [item.participants],
  );
  const excerpt = item.excerpt ? stripMarkdown(item.excerpt) : '';
  const last =
    item.last_reply_author && item.reply_count > 0
      ? `last from ${displayName(item.last_reply_author)} ${shortAgo(item.last_reply_at, nowMs)}`
      : null;

  return (
    <article aria-label={`Forum post: ${item.title}`} className="pc-home-card flex flex-col gap-3 px-4 pb-4 pt-3">
      <FeedCardHeader
        channelName={item.channel_name}
        forum
        when={when}
        onOpen={onOpen}
        aside={
          <span className="ml-auto shrink-0 rounded-[var(--radius-chip)] bg-bg-mod-subtle px-1.5 py-0.5 text-meta text-text-muted">
            Forum
          </span>
        }
      />
      <div className="flex gap-3">
        {!compact && <FeedAvatar user={item.author} size={36} />}
        <button
          type="button"
          onClick={onOpen}
          className="pc-focusable pc-home-card-hit -m-1 flex min-w-0 flex-1 flex-col gap-1.5 rounded-[var(--radius-control)] p-1 text-left"
        >
          <span className="text-meta text-text-muted">
            {item.author ? displayName(item.author) : 'Someone'} asked
          </span>
          <span className="pc-display text-heading text-text-primary">{item.title}</span>
          {excerpt && (
            <span className="pc-home-clamp text-body text-text-body" style={{ '--clamp-lines': 3 } as React.CSSProperties}>
              {excerpt}
            </span>
          )}
        </button>
      </div>
      <div className={cn('flex min-w-0 items-center gap-2.5', !compact && 'pl-12')}>
        {participants.length > 0 && <AvatarStack people={participants} size={22} max={5} context="in this post" />}
        <span className="truncate text-meta text-text-muted">
          {repliesLine(item.reply_count)}
          {last ? ` · ${last}` : ''}
        </span>
      </div>
    </article>
  );
});
