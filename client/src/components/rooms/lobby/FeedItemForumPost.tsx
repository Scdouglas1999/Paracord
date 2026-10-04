import { memo, useMemo } from 'react';

import { AvatarStack } from '../../ix/identity';
import type { FeedForumPostItem } from '../../../api/serverFeed';
import { displayName } from '../../../lib/displayName';
import { stripMarkdown } from '../../../lib/markdown';
import { FeedAvatar, FeedCardHeader } from './feedParts';
import { repliesLine, shortAgo } from './homeCaptions';

export interface FeedItemForumPostProps {
  item: FeedForumPostItem;
  when: string;
  nowMs: number;
  onOpen: () => void;
}

/**
 * A forum post, as a card of the event-card family (docs/index-spec.md §8.1): its title, the start of
 * what was asked, how many replies it has, who answered last and who has joined
 * in. The title and excerpt open the post.
 */
export const FeedItemForumPost = memo(function FeedItemForumPost({ item, when, nowMs, onOpen }: FeedItemForumPostProps) {
  const participants = useMemo(
    () =>
      item.participants.map((user) => ({
        userId: user.id,
        name: displayName(user),
        avatar: user.avatar_hash ?? null,
      })),
    [item.participants],
  );
  const excerpt = item.excerpt ? stripMarkdown(item.excerpt) : '';
  const last =
    item.last_reply_author && item.reply_count > 0
      ? `last from ${displayName(item.last_reply_author)} ${shortAgo(item.last_reply_at, nowMs)}`
      : null;
  const author = item.author ? displayName(item.author) : 'Someone';

  return (
    <article aria-label={`Forum post: ${item.title}`} className="ix-post">
      <FeedCardHeader
        lead={<FeedAvatar user={item.author} size={32} />}
        name={`${author} asked`}
        channelName={item.channel_name}
        forum
        when={when}
        onOpen={onOpen}
        aside={<span className="ix-tag">Forum</span>}
      />
      <button type="button" onClick={onOpen} className="ix-post__hit">
        <span className="ix-post__title">{item.title}</span>
        {excerpt && (
          <span className="ix-post__excerpt ix-clamp" style={{ '--clamp-lines': 3 } as React.CSSProperties}>
            {excerpt}
          </span>
        )}
      </button>
      <div className="ix-post__foot">
        {participants.length > 0 && <AvatarStack people={participants.slice(0, 5)} size={22} overlap={6} ring="var(--ix-card)" />}
        <span className="truncate">
          {repliesLine(item.reply_count)}
          {last ? ` · ${last}` : ''}
        </span>
      </div>
    </article>
  );
});
