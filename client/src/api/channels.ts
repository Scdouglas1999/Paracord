import { apiClient } from './client';
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

export const channelApi = {
  get: (id: string) => apiClient.get<Channel>(`/channels/${id}`),
  update: (id: string, data: Partial<Channel>) => apiClient.patch<Channel>(`/channels/${id}`, data),
  delete: (id: string) => apiClient.delete(`/channels/${id}`),

  getMessages: (id: string, params?: PaginationParams, config?: AxiosRequestConfig) =>
    apiClient.get<Message[]>(`/channels/${id}/messages`, { params, ...(config || {}) }),
  searchMessages: (
    id: string,
    q: string,
    limit = 20,
    filters?: MessageSearchFilters,
  ) =>
    apiClient.get<Message[]>(`/channels/${id}/messages/search`, {
      params: {
        q,
        limit,
        ...(filters || {}),
      },
    }),
  summarizeChannel: (id: string, limit = 150) =>
    apiClient.get<ChannelSummaryResponse>(`/channels/${id}/summary`, {
      params: { limit },
    }),
  getFeatureSettings: (id: string) =>
    apiClient.get<ChannelFeatureSettings>(`/channels/${id}/features`),
  updateFeatureSettings: (id: string, patch: Partial<ChannelFeatureSettings>) =>
    apiClient.patch<ChannelFeatureSettings>(`/channels/${id}/features`, patch),
  createScheduledMessage: (
    id: string,
    payload: { content?: string; e2ee?: unknown; nonce?: string; send_at: string },
  ) => apiClient.post<ScheduledMessage>(`/channels/${id}/scheduled-messages`, payload),
  listScheduledMessages: (id: string) =>
    apiClient.get<ScheduledMessage[]>(`/channels/${id}/scheduled-messages`),
  deleteScheduledMessage: (id: string, scheduledMessageId: string) =>
    apiClient.delete(`/channels/${id}/scheduled-messages/${scheduledMessageId}`),
  deanonymizeMessage: (id: string, messageId: string) =>
    apiClient.get<{
      message_id: string;
      channel_id: string;
      user_id: string;
      alias: string;
      user?: { id: string; username: string; discriminator: string | number; avatar_hash?: string | null };
    }>(`/channels/${id}/anonymous/deanonymize/${messageId}`),
  postGroupSenderKeys: (id: string, epoch: number, envelopes: GroupSenderKeyEnvelope[]) =>
    apiClient.post(`/channels/${id}/e2ee/sender-keys`, { epoch, envelopes }),
  getGroupSenderKeys: (id: string, sinceEpoch?: number) =>
    apiClient.get<{ sender_keys: GroupSenderKeyRecord[] }>(`/channels/${id}/e2ee/sender-keys`, {
      params: sinceEpoch == null ? undefined : { since_epoch: sinceEpoch },
    }),
  ackGroupSenderKeys: (
    id: string,
    payload: { sender_id?: string; up_to_epoch?: number },
  ) => apiClient.post<{ acknowledged: number }>(`/channels/${id}/e2ee/sender-keys/ack`, payload),
  bulkDeleteMessages: (id: string, messageIds: string[]) =>
    apiClient.post<{ deleted: number }>(`/channels/${id}/messages/bulk-delete`, { message_ids: messageIds }),
  sendMessage: (id: string, data: SendMessageRequest) =>
    apiClient.post<Message>(`/channels/${id}/messages`, data),
  editMessage: (channelId: string, messageId: string, data: EditMessageRequest) =>
    apiClient.patch<Message>(`/channels/${channelId}/messages/${messageId}`, data),
  deleteMessage: (channelId: string, messageId: string) =>
    apiClient.delete(`/channels/${channelId}/messages/${messageId}`),
  getEditHistory: (channelId: string, messageId: string) =>
    apiClient.get<{ id: string; message_id: string; content: string; edited_at: string }[]>(
      `/channels/${channelId}/messages/${messageId}/edits`
    ),

  getPins: (id: string) => apiClient.get<Message[]>(`/channels/${id}/pins`),
  pinMessage: (channelId: string, messageId: string) =>
    apiClient.put(`/channels/${channelId}/pins/${messageId}`),
  unpinMessage: (channelId: string, messageId: string) =>
    apiClient.delete(`/channels/${channelId}/pins/${messageId}`),

  addReaction: (channelId: string, messageId: string, emoji: string) =>
    apiClient.put(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
    ),
  removeReaction: (channelId: string, messageId: string, emoji: string) =>
    apiClient.delete(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
    ),

  triggerTyping: (id: string) => apiClient.post(`/channels/${id}/typing`),
  updateReadState: (id: string, lastMessageId?: string) =>
    apiClient.put(`/channels/${id}/read`, { last_message_id: lastMessageId }),

  updatePositions: (guildId: string, positions: { id: string; position: number; parent_id?: string | null }[]) =>
    apiClient.patch<{ updated: number }>(`/guilds/${guildId}/channels`, positions),

  createThread: (channelId: string, data: CreateThreadRequest) =>
    apiClient.post<Channel>(`/channels/${channelId}/threads`, data),
  getThreads: (channelId: string) =>
    apiClient.get<Channel[]>(`/channels/${channelId}/threads`),
  getArchivedThreads: (channelId: string) =>
    apiClient.get<Channel[]>(`/channels/${channelId}/threads/archived`),
  updateThread: (channelId: string, threadId: string, data: UpdateThreadRequest) =>
    apiClient.patch<Channel>(`/channels/${channelId}/threads/${threadId}`, data),
  deleteThread: (channelId: string, threadId: string) =>
    apiClient.delete(`/channels/${channelId}/threads/${threadId}`),

  createPoll: (channelId: string, data: CreatePollRequest) =>
    apiClient.post<Message>(`/channels/${channelId}/polls`, data),
  getPoll: (channelId: string, pollId: string) =>
    apiClient.get<Poll>(`/channels/${channelId}/polls/${pollId}`),
  addPollVote: (channelId: string, pollId: string, optionId: string) =>
    apiClient.put<Poll>(`/channels/${channelId}/polls/${pollId}/votes/${optionId}`),
  removePollVote: (channelId: string, pollId: string, optionId: string) =>
    apiClient.delete<Poll>(`/channels/${channelId}/polls/${pollId}/votes/${optionId}`),

  // Forum
  getForumPosts: (channelId: string, params?: { sort_order?: number; include_archived?: boolean }) =>
    apiClient.get<ForumPostsResponse>(`/channels/${channelId}/forum/posts`, { params }),
  createForumPost: (channelId: string, data: { name: string; content?: string; applied_tag_ids?: string[] }) =>
    apiClient.post<Channel>(`/channels/${channelId}/forum/posts`, data),
  getForumTags: (channelId: string) =>
    apiClient.get<ForumTag[]>(`/channels/${channelId}/forum/tags`),
  createForumTag: (channelId: string, data: { name: string; emoji?: string; moderated?: boolean }) =>
    apiClient.post<ForumTag>(`/channels/${channelId}/forum/tags`, data),
  deleteForumTag: (channelId: string, tagId: string) =>
    apiClient.delete(`/channels/${channelId}/forum/tags/${tagId}`),
  updateForumSortOrder: (channelId: string, sortOrder: number) =>
    apiClient.patch(`/channels/${channelId}/forum/sort`, { sort_order: sortOrder }),

  // Channel follows (announcement channels)
  getFollowers: (channelId: string) =>
    apiClient.get<{ id: string; source_channel_id: string; target_channel_id: string; target_guild_id: string; created_at: string }[]>(`/channels/${channelId}/followers`),
  addFollower: (channelId: string, targetChannelId: string, targetGuildId: string) =>
    apiClient.post(`/channels/${channelId}/followers`, { target_channel_id: targetChannelId, target_guild_id: targetGuildId }),
  removeFollower: (channelId: string, targetChannelId: string) =>
    apiClient.delete(`/channels/${channelId}/followers/${targetChannelId}`),

  // Visibility
  getVisibleChannels: (guildId: string) =>
    apiClient.get<{ channel_ids: string[] }>(`/guilds/${guildId}/channels/visible`),

  // Permission overwrites
  getOverwrites: (channelId: string) =>
    apiClient.get<ChannelOverwrite[]>(`/channels/${channelId}/overwrites`),
  upsertOverwrite: (channelId: string, targetId: string, data: UpsertChannelOverwriteRequest) =>
    apiClient.put(`/channels/${channelId}/overwrites/${targetId}`, data),
  deleteOverwrite: (channelId: string, targetId: string) =>
    apiClient.delete(`/channels/${channelId}/overwrites/${targetId}`),
};
