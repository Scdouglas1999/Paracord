import { getApi as getActiveApi } from './activeClient';
import { extractApiError } from './client';
import type { RestClient } from './restClient';

/** Where a feed comes from. */
export type FeedKind = 'rss' | 'youtube' | 'github' | 'twitch' | 'jellyfin';
export type GithubMode = 'releases' | 'commits' | 'tags';

export const FEED_KINDS: readonly FeedKind[] = ['rss', 'youtube', 'github', 'twitch', 'jellyfin'];

export interface FeedStatus {
  last_checked_at: string | null;
  last_success_at: string | null;
  next_check_at: string | null;
  last_posted_at: string | null;
  /** The last problem, in plain words, or null when the feed is healthy. */
  error: string | null;
}

export interface Feed {
  id: string;
  guild_id: string;
  channel_id: string;
  kind: FeedKind;
  name: string;
  icon_url: string | null;
  site_url: string | null;
  source_title: string | null;
  /** The source's address as the page shows it. */
  source: string | null;
  github_mode?: GithubMode | null;
  branch?: string | null;
  /** Jellyfin: a key is stored. The key itself never comes back. */
  api_key_set: boolean;
  show_on_front_page: boolean;
  paused: boolean;
  creator_id: string | null;
  created_at: string;
  status: FeedStatus;
}

export interface FeedList {
  enabled: boolean;
  feeds: Feed[];
  limit: number;
  /** The instance admin has set Twitch credentials. */
  twitch_available: boolean;
}

export interface FeedSourceInput {
  kind: FeedKind;
  input: string;
  github_mode?: GithubMode;
  branch?: string;
  api_key?: string;
}

export interface FeedItemSummary {
  title: string;
  link: string | null;
  published_at: string | null;
  thumbnail_url: string | null;
}

export interface FeedPreview {
  kind: FeedKind;
  name: string;
  title: string;
  icon_url: string | null;
  site_url: string | null;
  source: string;
  item_count: number;
  newest: FeedItemSummary | null;
}

export interface CreateFeedBody {
  source: FeedSourceInput;
  channel_id: string;
  name?: string;
  show_on_front_page?: boolean;
}

export interface CreatedFeed {
  feed: Feed;
  /** The newest item the source held when the feed was added. Nothing old posts. */
  newest: FeedItemSummary | null;
}

export interface UpdateFeedBody {
  name?: string;
  channel_id?: string;
  show_on_front_page?: boolean;
  paused?: boolean;
  api_key?: string;
}

/** The `feed` object on a message a feed posted. */
export interface MessageFeed {
  id: string;
  kind: FeedKind | string;
  name: string;
  icon_url?: string | null;
}

/** The feed-specific part of a card's embed. */
export interface FeedEmbedMeta {
  kind: FeedKind | string;
  video_id?: string | null;
  source_url?: string | null;
  /** Set on the "and N more from <source>" line. */
  more?: number | null;
}

export interface AdminAddons {
  local_network_allowed: boolean;
  twitch_client_id: string | null;
  twitch_secret_set: boolean;
  feeds_per_server: number;
}

export interface AdminAddonsUpdate {
  local_network_allowed?: boolean;
  /** Empty clears it. */
  twitch_client_id?: string;
  /** Empty clears it. Never sent back. */
  twitch_client_secret?: string;
}

export function createFeedsApi(getApi: () => RestClient) {
  return {
    list: (guildId: string) => getApi().get<FeedList>(`/guilds/${guildId}/feeds`),
    setEnabled: (guildId: string, enabled: boolean) =>
      getApi().put<{ enabled: boolean }>(`/guilds/${guildId}/feeds/settings`, { enabled }),
    preview: (guildId: string, source: FeedSourceInput) =>
      getApi().post<FeedPreview>(`/guilds/${guildId}/feeds/preview`, source),
    create: (guildId: string, body: CreateFeedBody) =>
      getApi().post<CreatedFeed>(`/guilds/${guildId}/feeds`, body),
    update: (guildId: string, feedId: string, body: UpdateFeedBody) =>
      getApi().patch<Feed>(`/guilds/${guildId}/feeds/${feedId}`, body),
    remove: (guildId: string, feedId: string) =>
      getApi().delete(`/guilds/${guildId}/feeds/${feedId}`),
    postLatest: (guildId: string, feedId: string) =>
      getApi().post<{ message_id: string }>(`/guilds/${guildId}/feeds/${feedId}/post-latest`),
    adminSettings: () => getApi().get<AdminAddons>('/admin/addons'),
    updateAdminSettings: (body: AdminAddonsUpdate) =>
      getApi().patch<AdminAddons>('/admin/addons', body),
  };
}

export const feedsApi = createFeedsApi(getActiveApi);

/**
 * A feeds error as the person should read it. The server's 400s arrive as
 * "bad request: <sentence>"; the sentence is written for people, the prefix is not.
 */
export function feedErrorMessage(err: unknown): string {
  return extractApiError(err).replace(/^bad request:\s*/i, '');
}
