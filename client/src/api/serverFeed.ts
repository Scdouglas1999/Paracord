import { getApi } from './activeClient';
import { hasListField, responseContract } from './responseContracts';
import type { Message } from '../types';

/**
 * `GET /guilds/{id}/feed` — what people made in a server, newest first.
 *
 * The server decides what is notable (an announcement, a picture or file, a
 * poll, a pinned message, a thread that got replies, a message with several
 * reactions) and filters by what the viewer can read. Plain chat is never in
 * it. `next_cursor` is null once there is nothing older.
 */

export interface FeedUser {
  id: string;
  username: string;
  display_name: string | null;
  avatar_hash: string | null;
}

export type FeedReason =
  | 'announcement'
  | 'attachment'
  | 'poll'
  | 'reactions'
  | 'pinned'
  | 'thread_starter'
  /** Posted by a feed (Server settings → Add-ons → Feeds) set to show on the front page. */
  | 'feed';

interface FeedItemBase {
  /** Unique across item types: `m:<id>`, `f:<id>`, `j:<day>`. */
  id: string;
  /** This item's cursor; the page's last one is `next_cursor`. */
  key: string;
  /** When it happened, RFC 3339. */
  at: string;
}

export interface FeedMessageItem extends FeedItemBase {
  type: 'message';
  message: Message;
  channel_id: string;
  channel_name: string;
  channel_type?: number;
  thread_parent_id?: string | null;
  reason: FeedReason;
  /**
   * Older posts from the same feed that came right after this one, folded
   * into this card, newest first. Absent on every other card.
   */
  feed_group?: FeedGroup | null;
}

/** A run of posts from one feed, shown as one card on the front page. */
export interface FeedGroup {
  feed_id: string | null;
  name: string | null;
  items: FeedGroupPost[];
}

export interface FeedGroupPost {
  message_id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  at: string;
}

export interface FeedForumPostItem extends FeedItemBase {
  type: 'forum_post';
  channel_id: string;
  channel_name: string;
  thread_id: string;
  title: string;
  author: FeedUser | null;
  excerpt: string | null;
  reply_count: number;
  last_reply_at: string | null;
  last_reply_author: FeedUser | null;
  participants: FeedUser[];
}

export interface FeedMembersJoinedItem extends FeedItemBase {
  type: 'members_joined';
  day: string;
  users: FeedUser[];
  total: number;
}

export type FeedItem = FeedMessageItem | FeedForumPostItem | FeedMembersJoinedItem;

export interface FeedPage {
  items: FeedItem[];
  next_cursor: string | null;
}

export const serverFeedApi = {
  page: (guildId: string, before: string | null, limit = 20) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    return responseContract(
      getApi().get<unknown>(`/guilds/${guildId}/feed?${params.toString()}`),
      hasListField<FeedPage>('items'),
      'server feed',
    );
  },
};
