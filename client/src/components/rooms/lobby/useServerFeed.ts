import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { channelApi } from '../../../api/channels';
import { extractApiError } from '../../../api/client';
import { serverFeedApi, type FeedItem, type FeedMessageItem } from '../../../api/serverFeed';
import { toast } from '../../../stores/toastStore';
import type { Reaction } from '../../../types';

export const FEED_PAGE = 20;

export interface ServerFeed {
  items: FeedItem[];
  /** The first page has not come back yet. */
  loading: boolean;
  /** An older page is on its way. */
  loadingMore: boolean;
  /** Why the last request failed, shown where the feed would be. */
  error: string | null;
  /** There is nothing older. */
  done: boolean;
  loadMore: () => void;
  retry: () => void;
  toggleReaction: (item: FeedMessageItem, reaction: Reaction) => void;
}

/** Append a page, dropping anything already on the page (a re-fetch can overlap). */
export function mergeFeedPage(current: readonly FeedItem[], page: readonly FeedItem[]): FeedItem[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...page.filter((item) => !seen.has(item.id))];
}

/** A reaction toggled on one message, counted the way the server will count it. */
export function applyReaction(item: FeedMessageItem, emoji: string, add: boolean): FeedMessageItem {
  const reactions = ((item.message.reactions ?? []) as Reaction[]).map((reaction) => ({ ...reaction }));
  const index = reactions.findIndex((reaction) => reaction.emoji === emoji);
  if (add) {
    if (index === -1) reactions.push({ emoji, count: 1, me: true });
    else if (!reactions[index].me) reactions[index] = { ...reactions[index], count: reactions[index].count + 1, me: true };
  } else if (index !== -1 && reactions[index].me) {
    const count = reactions[index].count - 1;
    if (count <= 0) reactions.splice(index, 1);
    else reactions[index] = { ...reactions[index], count, me: false };
  }
  return { ...item, message: { ...item.message, reactions } };
}

/**
 * The server's feed, a page at a time, newest first. `loadMore` asks for the
 * page before the last one; the list never refetches what it already has.
 */
export function useServerFeed(guildId: string): ServerFeed {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const fetchPage = useCallback(
    async (before: string | null) => {
      const mine = generation.current;
      inFlight.current = true;
      if (before) setLoadingMore(true);
      try {
        const { data } = await serverFeedApi.page(guildId, before, FEED_PAGE);
        if (mine !== generation.current) return;
        setItems((current) => (before ? mergeFeedPage(current, data.items) : data.items));
        setCursor(data.next_cursor);
        setDone(!data.next_cursor);
        setError(null);
      } catch (err) {
        if (mine !== generation.current) return;
        setError(extractApiError(err));
      } finally {
        if (mine === generation.current) {
          inFlight.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [guildId],
  );

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setItems([]);
    setCursor(null);
    setDone(false);
    setError(null);
    setLoading(true);
    void fetchPage(null);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (inFlight.current || done || !cursor || error) return;
    void fetchPage(cursor);
  }, [cursor, done, error, fetchPage]);

  const retry = useCallback(() => {
    if (inFlight.current) return;
    setError(null);
    if (items.length === 0) setLoading(true);
    void fetchPage(items.length === 0 ? null : cursor);
  }, [cursor, fetchPage, items.length]);

  const toggleReaction = useCallback((item: FeedMessageItem, reaction: Reaction) => {
    const add = !reaction.me;
    const replace = (update: (entry: FeedMessageItem) => FeedMessageItem) =>
      setItems((current) =>
        current.map((entry) => (entry.id === item.id && entry.type === 'message' ? update(entry) : entry)),
      );
    replace((entry) => applyReaction(entry, reaction.emoji, add));
    const request = add
      ? channelApi.addReaction(item.message.channel_id, item.message.id, reaction.emoji)
      : channelApi.removeReaction(item.message.channel_id, item.message.id, reaction.emoji);
    request.catch((err) => {
      replace((entry) => applyReaction(entry, reaction.emoji, !add));
      toast.error(`Could not ${add ? 'add' : 'remove'} the reaction: ${extractApiError(err)}`);
    });
  }, []);

  // One object per state, so a memoised feed does not redraw because the page
  // around it did.
  return useMemo(
    () => ({ items, loading, loadingMore, error, done, loadMore, retry, toggleReaction }),
    [items, loading, loadingMore, error, done, loadMore, retry, toggleReaction],
  );
}
