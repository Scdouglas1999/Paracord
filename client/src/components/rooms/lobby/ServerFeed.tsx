import { Fragment, useEffect, useRef, type ReactNode, type RefObject } from 'react';

import { Button } from '../../ui';
import type { FeedItem, FeedUser } from '../../../api/serverFeed';
import { FeedItemForumPost } from './FeedItemForumPost';
import { FeedItemMembersJoined } from './FeedItemMembersJoined';
import { FeedItemMessage } from './FeedItemMessage';
import { shortAgo } from './homeCaptions';
import type { ServerFeed as ServerFeedModel } from './useServerFeed';

export interface ServerFeedProps {
  guildId: string;
  feed: ServerFeedModel;
  /** The page's scroller, which the next page is fetched ahead of. */
  scrollRoot: RefObject<HTMLElement | null>;
  mentionNames: Map<string, string>;
  viewerId: string | null;
  nowMs: number;
  /** On a phone, the widgets that sit inside the feed after its fourth item. */
  interleave?: ReactNode;
  onOpenMessage: (channelId: string, messageId: string) => void;
  onOpenChannel: (channelId: string) => void;
  onSayHi: (user: FeedUser) => void;
  compact?: boolean;
}

/** Items before the phone's widget block. */
const INTERLEAVE_AFTER = 4;

/**
 * "Latest": what people made across every channel the viewer can read, newest
 * first, a page at a time as the reader reaches the end.
 */
export function ServerFeed({
  guildId,
  feed,
  scrollRoot,
  mentionNames,
  viewerId,
  nowMs,
  interleave,
  onOpenMessage,
  onOpenChannel,
  onSayHi,
  compact = false,
}: ServerFeedProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { items, loading, loadingMore, error, done, loadMore, retry } = feed;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || done || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: scrollRoot.current, rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [done, loadMore, scrollRoot, items.length]);

  const render = (item: FeedItem) => {
    const when = shortAgo(item.at, nowMs);
    switch (item.type) {
      case 'message':
        return (
          <FeedItemMessage
            item={item}
            guildId={guildId}
            when={when}
            mentionNames={mentionNames}
            onOpen={() => onOpenMessage(item.channel_id, item.message.id)}
            onToggleReaction={(reaction) => feed.toggleReaction(item, reaction)}
            compact={compact}
          />
        );
      case 'forum_post':
        return (
          <FeedItemForumPost
            item={item}
            when={when}
            nowMs={nowMs}
            compact={compact}
            onOpen={() => onOpenChannel(item.thread_id)}
          />
        );
      case 'members_joined':
        return <FeedItemMembersJoined item={item} when={when} viewerId={viewerId} onSayHi={onSayHi} />;
    }
  };

  return (
    <section aria-labelledby={`latest-${guildId}`} aria-busy={loading || loadingMore} className="flex flex-col gap-3">
      <h2 id={`latest-${guildId}`} className="pc-home-heading">
        Latest
      </h2>

      {loading && items.length === 0 && (
        <div role="status" aria-label="Loading the latest posts" className="flex flex-col gap-3">
          {[0, 1].map((index) => (
            <div key={index} className="pc-home-card pc-skeleton h-40" aria-hidden />
          ))}
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <p className="rounded-[var(--radius-card)] px-4 py-6 text-body text-text-muted shadow-[inset_0_0_0_1px_var(--border-subtle)]">
          Pictures, polls, announcements and busy threads from every channel show up here. Nothing yet.
        </p>
      )}

      {items.map((item, index) => (
        <Fragment key={item.id}>
          {render(item)}
          {interleave && index === Math.min(INTERLEAVE_AFTER, items.length) - 1 && interleave}
        </Fragment>
      ))}
      {interleave && items.length === 0 && !loading && interleave}

      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] bg-danger-well px-4 py-3">
          <p className="min-w-0 flex-1 text-label text-accent-danger">Could not load the latest posts: {error}</p>
          <Button variant="ghost" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}

      {!done && !error && <div ref={sentinel} className="h-px" aria-hidden />}
      {loadingMore && (
        <p role="status" className="py-2 text-center text-meta text-text-muted">
          Loading older posts…
        </p>
      )}
      {done && items.length > 0 && (
        <p className="py-3 text-center text-meta text-text-faint">That’s everything.</p>
      )}
    </section>
  );
}
