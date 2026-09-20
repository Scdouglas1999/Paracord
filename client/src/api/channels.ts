import type { RestClient } from './restClient';
import { getApi as getActiveApi } from './activeClient';
import type { AxiosRequestConfig } from 'axios';
import type {
  Channel,
  ChannelOverwrite,
  EditMessageRequest,
  ForumPostsResponse,
  ForumTag,
  Message,
  PaginationParams,
  Poll,
  SendMessageRequest,
  UpsertChannelOverwriteRequest,
} from '../types';

export interface MessageEditHistoryEntry {
  id: string;
  message_id: string;
  content: string;
  edited_at: string;
}

interface CreateThreadRequest {
  name: string;
  message_id?: string;
  auto_archive_duration?: number;
}

interface UpdateThreadRequest {
  name?: string;
  archived?: boolean;
  locked?: boolean;
}

interface CreatePollOptionRequest {
  text: string;
  emoji?: string;
}

interface CreatePollRequest {
  question: string;
  options: CreatePollOptionRequest[];
  allow_multiselect?: boolean;
  expires_in_minutes?: number;
}

interface MessageSearchFilters {
  author_id?: string;
  after?: string;
  before?: string;
}

export interface ChannelSummaryResponse {
  channel_id: string;
  provider: string;
  model: string;
  message_count: number;
  summary: string;
}

export interface ChannelFeatureSettings {
  channel_id: string;
  disappearing_seconds: number;
  anonymous_posting_enabled: boolean;
  slowmode_exempt_role_ids: string[];
  adaptive_slowmode_enabled: boolean;
  adaptive_slowmode_window_seconds: number;
  adaptive_slowmode_threshold: number;
  adaptive_slowmode_step_seconds: number;
  thread_rate_limit_per_user: number;
}

export interface ScheduledMessage {
  id: string;
  channel_id: string;
  author_id: string;
  content?: string | null;
  e2ee?: unknown;
  nonce?: string | null;
  send_at: string;
  status: number;
  error?: string | null;
  delivered_message_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupSenderKeyEnvelope {
  recipient_id: string;
  ciphertext: string;
  header?: string;
}

export interface GroupSenderKeyRecord {
  id: string;
  channel_id: string;
  sender_id: string;
  recipient_id: string;
  epoch: number;
  ciphertext: string;
  header?: string | null;
  created_at: string;
}

export function createChannelApi(getApi: () => RestClient) {
  return {
    get: async (id: string) => getApi().get<Channel>(`/channels/${id}`),
    update: async (id: string, data: Partial<Channel>) => getApi().patch<Channel>(`/channels/${id}`, data),
    delete: async (id: string) => getApi().delete(`/channels/${id}`),

    getMessages: async (id: string, params?: PaginationParams, config?: AxiosRequestConfig) =>
      getApi().get<Message[]>(`/channels/${id}/messages`, { params, ...(config || {}) }),
    searchMessages: async (
      id: string,
      q: string,
      limit = 20,
      filters?: MessageSearchFilters,
    ) =>
      getApi().get<Message[]>(`/channels/${id}/messages/search`, {
        params: {
          q,
          limit,
          ...(filters || {}),
        },
      }),
    summarizeChannel: async (id: string, limit = 150) =>
      getApi().get<ChannelSummaryResponse>(`/channels/${id}/summary`, {
        params: { limit },
      }),
    getFeatureSettings: async (id: string) =>
      getApi().get<ChannelFeatureSettings>(`/channels/${id}/features`),
    updateFeatureSettings: async (id: string, patch: Partial<ChannelFeatureSettings>) =>
      getApi().patch<ChannelFeatureSettings>(`/channels/${id}/features`, patch),
    createScheduledMessage: async (
      id: string,
      payload: { content?: string; e2ee?: unknown; nonce?: string; send_at: string },
    ) => getApi().post<ScheduledMessage>(`/channels/${id}/scheduled-messages`, payload),
    listScheduledMessages: async (id: string) =>
      getApi().get<ScheduledMessage[]>(`/channels/${id}/scheduled-messages`),
    updateScheduledMessage: async (
      id: string,
      scheduledMessageId: string,
      payload: { content?: string; e2ee?: unknown; nonce?: string; send_at: string },
    ) =>
      getApi().patch<ScheduledMessage>(
        `/channels/${id}/scheduled-messages/${scheduledMessageId}`,
        payload,
      ),
    deleteScheduledMessage: async (id: string, scheduledMessageId: string) =>
      getApi().delete(`/channels/${id}/scheduled-messages/${scheduledMessageId}`),
    deanonymizeMessage: async (id: string, messageId: string) =>
      getApi().get<{
        message_id: string;
        channel_id: string;
        user_id: string;
        alias: string;
        user?: { id: string; username: string; discriminator: string | number; avatar_hash?: string | null };
      }>(`/channels/${id}/anonymous/deanonymize/${messageId}`),
    postGroupSenderKeys: async (id: string, epoch: number, envelopes: GroupSenderKeyEnvelope[], membersVersion?: string) =>
      getApi().post(`/channels/${id}/e2ee/sender-keys`, { epoch, envelopes, members_version: membersVersion }),
    getGroupSenderKeys: async (id: string, sinceEpoch?: number) =>
      getApi().get<{ sender_keys: GroupSenderKeyRecord[]; members_version?: string }>(`/channels/${id}/e2ee/sender-keys`, {
        params: sinceEpoch == null ? undefined : { since_epoch: sinceEpoch },
      }),
    ackGroupSenderKeys: async (
      id: string,
      payload: { sender_id?: string; up_to_epoch?: number },
    ) => getApi().post<{ acknowledged: number }>(`/channels/${id}/e2ee/sender-keys/ack`, payload),
    bulkDeleteMessages: async (id: string, messageIds: string[]) =>
      getApi().post<{ deleted: number }>(`/channels/${id}/messages/bulk-delete`, { message_ids: messageIds }),
    sendMessage: async (id: string, data: SendMessageRequest) =>
      getApi().post<Message>(`/channels/${id}/messages`, data),
    editMessage: async (channelId: string, messageId: string, data: EditMessageRequest) =>
      getApi().patch<Message>(`/channels/${channelId}/messages/${messageId}`, data),
    deleteMessage: async (channelId: string, messageId: string) =>
      getApi().delete(`/channels/${channelId}/messages/${messageId}`),
    getEditHistory: async (channelId: string, messageId: string) =>
      getApi().get<MessageEditHistoryEntry[]>(
        `/channels/${channelId}/messages/${messageId}/edits`
      ),

    getPins: async (id: string) => getApi().get<Message[]>(`/channels/${id}/pins`),
    pinMessage: async (channelId: string, messageId: string) =>
      getApi().put(`/channels/${channelId}/pins/${messageId}`),
    unpinMessage: async (channelId: string, messageId: string) =>
      getApi().delete(`/channels/${channelId}/pins/${messageId}`),

    addReaction: async (channelId: string, messageId: string, emoji: string) =>
      getApi().put(
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
      ),
    removeReaction: async (channelId: string, messageId: string, emoji: string) =>
      getApi().delete(
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
      ),

    /**
   * `stop` ends the indicator. Without it the only thing that ever cleared
   * "…is typing" was the recipient's own expiry timer, so it outlived the
   * message it announced by several seconds.
   */
  triggerTyping: async (id: string, stop = false) =>
    getApi().post(`/channels/${id}/typing${stop ? '?stop=true' : ''}`),
    updateReadState: async (id: string, lastMessageId?: string) =>
      getApi().put(`/channels/${id}/read`, { last_message_id: lastMessageId }),


    updatePositions: async (guildId: string, positions: { id: string; position: number; parent_id?: string | null }[]) =>
      getApi().patch<{ updated: number }>(`/guilds/${guildId}/channels`, positions),

    createThread: async (channelId: string, data: CreateThreadRequest) =>
      getApi().post<Channel>(`/channels/${channelId}/threads`, data),
    getThreads: async (channelId: string) =>
      getApi().get<Channel[]>(`/channels/${channelId}/threads`),
    getArchivedThreads: async (channelId: string) =>
      getApi().get<Channel[]>(`/channels/${channelId}/threads/archived`),
    updateThread: async (channelId: string, threadId: string, data: UpdateThreadRequest) =>
      getApi().patch<Channel>(`/channels/${channelId}/threads/${threadId}`, data),
    deleteThread: async (channelId: string, threadId: string) =>
      getApi().delete(`/channels/${channelId}/threads/${threadId}`),

    createPoll: async (channelId: string, data: CreatePollRequest) =>
      getApi().post<Message>(`/channels/${channelId}/polls`, data),
    getPoll: async (channelId: string, pollId: string) =>
      getApi().get<Poll>(`/channels/${channelId}/polls/${pollId}`),
    addPollVote: async (channelId: string, pollId: string, optionId: string) =>
      getApi().put<Poll>(`/channels/${channelId}/polls/${pollId}/votes/${optionId}`),
    removePollVote: async (channelId: string, pollId: string, optionId: string) =>
      getApi().delete<Poll>(`/channels/${channelId}/polls/${pollId}/votes/${optionId}`),

    // Forum
    getForumPosts: async (channelId: string, params?: { sort_order?: number; include_archived?: boolean }) =>
      getApi().get<ForumPostsResponse>(`/channels/${channelId}/forum/posts`, { params }),
    createForumPost: async (channelId: string, data: { name: string; content?: string; applied_tag_ids?: string[] }) =>
      getApi().post<Channel>(`/channels/${channelId}/forum/posts`, data),
    getForumTags: async (channelId: string) =>
      getApi().get<ForumTag[]>(`/channels/${channelId}/forum/tags`),
    createForumTag: async (channelId: string, data: { name: string; emoji?: string; moderated?: boolean }) =>
      getApi().post<ForumTag>(`/channels/${channelId}/forum/tags`, data),
    deleteForumTag: async (channelId: string, tagId: string) =>
      getApi().delete(`/channels/${channelId}/forum/tags/${tagId}`),
    updateForumSortOrder: async (channelId: string, sortOrder: number) =>
      getApi().patch(`/channels/${channelId}/forum/sort`, { sort_order: sortOrder }),

    // Channel follows (announcement channels)
    getFollowers: async (channelId: string) =>
      getApi().get<{ id: string; source_channel_id: string; target_channel_id: string; target_guild_id: string; created_at: string }[]>(`/channels/${channelId}/followers`),
    addFollower: async (channelId: string, targetChannelId: string, targetGuildId: string) =>
      getApi().post(`/channels/${channelId}/followers`, { target_channel_id: targetChannelId, target_guild_id: targetGuildId }),
    removeFollower: async (channelId: string, targetChannelId: string) =>
      getApi().delete(`/channels/${channelId}/followers/${targetChannelId}`),

    // Visibility
    getVisibleChannels: async (guildId: string, config?: AxiosRequestConfig) =>
      getApi().get<{ channel_ids: string[] }>(`/guilds/${guildId}/channels/visible`, config),

    // Permission overwrites
    getOverwrites: async (channelId: string) =>
      getApi().get<ChannelOverwrite[]>(`/channels/${channelId}/overwrites`),
    upsertOverwrite: async (channelId: string, targetId: string, data: UpsertChannelOverwriteRequest) =>
      getApi().put(`/channels/${channelId}/overwrites/${targetId}`, data),
    deleteOverwrite: async (channelId: string, targetId: string) =>
      getApi().delete(`/channels/${channelId}/overwrites/${targetId}`),
  };
}

export const channelApi = createChannelApi(getActiveApi);
