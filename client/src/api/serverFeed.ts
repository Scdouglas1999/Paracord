import { getApi } from './activeClient';
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
  | 'thread_starter';

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
    return getApi().get<FeedPage>(`/guilds/${guildId}/feed?${params.toString()}`);
  },
};
