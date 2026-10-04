import { Fragment, memo, useEffect, useRef, useState } from 'react';

import type { FeedItem, FeedUser } from '../../../api/serverFeed';
import type { Reaction } from '../../../types';
import { FeedItemForumPost } from './FeedItemForumPost';
import { FeedItemMembersJoined } from './FeedItemMembersJoined';
import { FeedItemMessage } from './FeedItemMessage';
import { shortAgo } from './homeCaptions';
import type { ServerFeed as ServerFeedModel } from './useServerFeed';

export interface ServerFeedProps {
  guildId: string;
  feed: ServerFeedModel;
  mentionNames: Map<string, string>;
  viewerId: string | null;
  nowMs: number;
  onOpenMessage: (channelId: string, messageId: string) => void;
  onOpenChannel: (channelId: string) => void;
  onSayHi: (user: FeedUser) => void;
}

/** One card's handlers, made once per item and kept for as long as it is shown. */
interface ItemHandlers {
  open: () => void;
  toggleReaction: (reaction: Reaction) => void;
}

/**
 * "Latest": what people made across every channel the viewer can read, newest
 * first, a page at a time as the reader reaches the end.
 *
 * Memoised, and so is every card: the home around it re-renders whenever
 * somebody speaks or comes online, and none of that changes a post. A card
 * redraws when its own item, its "when" or its settings change.
 */
export const ServerFeed = memo(function ServerFeed({
  guildId,
  feed,
  mentionNames,
  viewerId,
  nowMs,
  onOpenMessage,
  onOpenChannel,
  onSayHi,
}: ServerFeedProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { items, loading, loadingMore, error, done, loadMore, retry } = feed;

  // The cards keep their handlers across renders so they can skip them; each
  // handler reads the latest item and callbacks when it is actually used.
  const latest = useRef({ items, onOpenMessage, onOpenChannel, toggleReaction: feed.toggleReaction });
  latest.current = { items, onOpenMessage, onOpenChannel, toggleReaction: feed.toggleReaction };
  const [handlers] = useState(() => new Map<string, ItemHandlers>());
  const [openMessage] = useState(() => (channelId: string, messageId: string) =>
    latest.current.onOpenMessage(channelId, messageId),
  );
  const handlersFor = (id: string): ItemHandlers => {
    let entry = handlers.get(id);
    if (!entry) {
      const current = () => {
        const item = latest.current.items.find((candidate) => candidate.id === id);
        if (!item) throw new Error(`ServerFeed: card ${id} is no longer in the feed`);
        return item;
      };
      entry = {
        open: () => {
          const item = current();
          if (item.type === 'message') latest.current.onOpenMessage(item.channel_id, item.message.id);
          else if (item.type === 'forum_post') latest.current.onOpenChannel(item.thread_id);
        },
        toggleReaction: (reaction) => {
          const item = current();
          if (item.type !== 'message') throw new Error(`ServerFeed: card ${id} has no reactions`);
          latest.current.toggleReaction(item, reaction);
        },
      };
      handlers.set(id, entry);
    }
    return entry;
  };

  useEffect(() => {
    const node = sentinel.current;
    if (!node || done || typeof IntersectionObserver === 'undefined') return;
    // The next page is fetched ahead of the reader, in the page's own scroller
    // (the large-title page, `.ix-page`): a viewport root would not see past its clip.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: node.closest<HTMLElement>('.ix-page'), rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [done, loadMore, items.length]);

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
            onOpen={handlersFor(item.id).open}
            onToggleReaction={handlersFor(item.id).toggleReaction}
            nowMs={item.feed_group ? nowMs : undefined}
            onOpenMessage={openMessage}
          />
        );
      case 'forum_post':
        return (
          <FeedItemForumPost
            item={item}
            when={when}
            nowMs={nowMs}
            onOpen={handlersFor(item.id).open}
          />
        );
      case 'members_joined':
        return <FeedItemMembersJoined item={item} when={when} viewerId={viewerId} onSayHi={onSayHi} />;
    }
  };

  return (
    <section aria-labelledby={`latest-${guildId}`} aria-busy={loading || loadingMore} className="ix-sec">
      <div className="ix-sec__head">
        <h2 id={`latest-${guildId}`} className="ix-sec__label">
          Latest
        </h2>
      </div>

      {loading && items.length === 0 && (
        <div role="status" aria-label="Loading the latest posts" className="ix-feed">
          {[0, 1].map((index) => (
            <div key={index} className="ix-post ix-post--skeleton" aria-hidden />
          ))}
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <p className="ix-sec__note">
          Pictures, polls, announcements and busy threads from every channel show up here. Nothing yet.
        </p>
      )}

      <div className="ix-feed">
        {items.map((item) => (
          <Fragment key={item.id}>{render(item)}</Fragment>
        ))}
      </div>

      {error && (
        <div role="alert" className="ix-note" data-tone="danger">
          <span>Could not load the latest posts: {error}</span>
          <button type="button" className="ix-link" onClick={retry}>
            Try again
          </button>
        </div>
      )}

      {!done && !error && <div ref={sentinel} className="ix-sentinel" aria-hidden />}
      {loadingMore && (
        <p role="status" className="ix-sec__note" data-center>
          Loading older posts…
        </p>
      )}
      {done && items.length > 0 && (
        <p className="ix-sec__note" data-center>
          That’s everything.
        </p>
      )}
    </section>
  );
});
