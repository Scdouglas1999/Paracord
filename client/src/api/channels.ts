import { getApi } from './activeClient';
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
  get: (id: string) => getApi().get<Channel>(`/channels/${id}`),
  update: (id: string, data: Partial<Channel>) => getApi().patch<Channel>(`/channels/${id}`, data),
  delete: (id: string) => getApi().delete(`/channels/${id}`),

  getMessages: (id: string, params?: PaginationParams, config?: AxiosRequestConfig) =>
    getApi().get<Message[]>(`/channels/${id}/messages`, { params, ...(config || {}) }),
  searchMessages: (
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
  summarizeChannel: (id: string, limit = 150) =>
    getApi().get<ChannelSummaryResponse>(`/channels/${id}/summary`, {
      params: { limit },
    }),
  getFeatureSettings: (id: string) =>
    getApi().get<ChannelFeatureSettings>(`/channels/${id}/features`),
  updateFeatureSettings: (id: string, patch: Partial<ChannelFeatureSettings>) =>
    getApi().patch<ChannelFeatureSettings>(`/channels/${id}/features`, patch),
  createScheduledMessage: (
    id: string,
    payload: { content?: string; e2ee?: unknown; nonce?: string; send_at: string },
  ) => getApi().post<ScheduledMessage>(`/channels/${id}/scheduled-messages`, payload),
  listScheduledMessages: (id: string) =>
    getApi().get<ScheduledMessage[]>(`/channels/${id}/scheduled-messages`),
  updateScheduledMessage: (
    id: string,
    scheduledMessageId: string,
    payload: { content?: string; e2ee?: unknown; nonce?: string; send_at: string },
  ) =>
    getApi().patch<ScheduledMessage>(
      `/channels/${id}/scheduled-messages/${scheduledMessageId}`,
      payload,
    ),
  deleteScheduledMessage: (id: string, scheduledMessageId: string) =>
    getApi().delete(`/channels/${id}/scheduled-messages/${scheduledMessageId}`),
  deanonymizeMessage: (id: string, messageId: string) =>
    getApi().get<{
      message_id: string;
      channel_id: string;
      user_id: string;
      alias: string;
      user?: { id: string; username: string; discriminator: string | number; avatar_hash?: string | null };
    }>(`/channels/${id}/anonymous/deanonymize/${messageId}`),
  postGroupSenderKeys: (id: string, epoch: number, envelopes: GroupSenderKeyEnvelope[]) =>
    getApi().post(`/channels/${id}/e2ee/sender-keys`, { epoch, envelopes }),
  getGroupSenderKeys: (id: string, sinceEpoch?: number) =>
    getApi().get<{ sender_keys: GroupSenderKeyRecord[] }>(`/channels/${id}/e2ee/sender-keys`, {
      params: sinceEpoch == null ? undefined : { since_epoch: sinceEpoch },
    }),
  ackGroupSenderKeys: (
    id: string,
    payload: { sender_id?: string; up_to_epoch?: number },
  ) => getApi().post<{ acknowledged: number }>(`/channels/${id}/e2ee/sender-keys/ack`, payload),
  bulkDeleteMessages: (id: string, messageIds: string[]) =>
    getApi().post<{ deleted: number }>(`/channels/${id}/messages/bulk-delete`, { message_ids: messageIds }),
  sendMessage: (id: string, data: SendMessageRequest) =>
    getApi().post<Message>(`/channels/${id}/messages`, data),
  editMessage: (channelId: string, messageId: string, data: EditMessageRequest) =>
    getApi().patch<Message>(`/channels/${channelId}/messages/${messageId}`, data),
  deleteMessage: (channelId: string, messageId: string) =>
    getApi().delete(`/channels/${channelId}/messages/${messageId}`),
  getEditHistory: (channelId: string, messageId: string) =>
    getApi().get<{ id: string; message_id: string; content: string; edited_at: string }[]>(
      `/channels/${channelId}/messages/${messageId}/edits`
    ),

  getPins: (id: string) => getApi().get<Message[]>(`/channels/${id}/pins`),
  pinMessage: (channelId: string, messageId: string) =>
    getApi().put(`/channels/${channelId}/pins/${messageId}`),
  unpinMessage: (channelId: string, messageId: string) =>
    getApi().delete(`/channels/${channelId}/pins/${messageId}`),

  addReaction: (channelId: string, messageId: string, emoji: string) =>
    getApi().put(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
    ),
  removeReaction: (channelId: string, messageId: string, emoji: string) =>
    getApi().delete(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
    ),

  triggerTyping: (id: string) => getApi().post(`/channels/${id}/typing`),
  updateReadState: (id: string, lastMessageId?: string) =>
    getApi().put(`/channels/${id}/read`, { last_message_id: lastMessageId }),

  updatePositions: (guildId: string, positions: { id: string; position: number; parent_id?: string | null }[]) =>
    getApi().patch<{ updated: number }>(`/guilds/${guildId}/channels`, positions),

  createThread: (channelId: string, data: CreateThreadRequest) =>
    getApi().post<Channel>(`/channels/${channelId}/threads`, data),
  getThreads: (channelId: string) =>
    getApi().get<Channel[]>(`/channels/${channelId}/threads`),
  getArchivedThreads: (channelId: string) =>
    getApi().get<Channel[]>(`/channels/${channelId}/threads/archived`),
  updateThread: (channelId: string, threadId: string, data: UpdateThreadRequest) =>
    getApi().patch<Channel>(`/channels/${channelId}/threads/${threadId}`, data),
  deleteThread: (channelId: string, threadId: string) =>
    getApi().delete(`/channels/${channelId}/threads/${threadId}`),

  createPoll: (channelId: string, data: CreatePollRequest) =>
    getApi().post<Message>(`/channels/${channelId}/polls`, data),
  getPoll: (channelId: string, pollId: string) =>
    getApi().get<Poll>(`/channels/${channelId}/polls/${pollId}`),
  addPollVote: (channelId: string, pollId: string, optionId: string) =>
    getApi().put<Poll>(`/channels/${channelId}/polls/${pollId}/votes/${optionId}`),
  removePollVote: (channelId: string, pollId: string, optionId: string) =>
    getApi().delete<Poll>(`/channels/${channelId}/polls/${pollId}/votes/${optionId}`),

  // Forum
  getForumPosts: (channelId: string, params?: { sort_order?: number; include_archived?: boolean }) =>
    getApi().get<ForumPostsResponse>(`/channels/${channelId}/forum/posts`, { params }),
  createForumPost: (channelId: string, data: { name: string; content?: string; applied_tag_ids?: string[] }) =>
    getApi().post<Channel>(`/channels/${channelId}/forum/posts`, data),
  getForumTags: (channelId: string) =>
    getApi().get<ForumTag[]>(`/channels/${channelId}/forum/tags`),
  createForumTag: (channelId: string, data: { name: string; emoji?: string; moderated?: boolean }) =>
    getApi().post<ForumTag>(`/channels/${channelId}/forum/tags`, data),
  deleteForumTag: (channelId: string, tagId: string) =>
    getApi().delete(`/channels/${channelId}/forum/tags/${tagId}`),
  updateForumSortOrder: (channelId: string, sortOrder: number) =>
    getApi().patch(`/channels/${channelId}/forum/sort`, { sort_order: sortOrder }),

  // Channel follows (announcement channels)
  getFollowers: (channelId: string) =>
    getApi().get<{ id: string; source_channel_id: string; target_channel_id: string; target_guild_id: string; created_at: string }[]>(`/channels/${channelId}/followers`),
  addFollower: (channelId: string, targetChannelId: string, targetGuildId: string) =>
    getApi().post(`/channels/${channelId}/followers`, { target_channel_id: targetChannelId, target_guild_id: targetGuildId }),
  removeFollower: (channelId: string, targetChannelId: string) =>
    getApi().delete(`/channels/${channelId}/followers/${targetChannelId}`),

  // Visibility
  getVisibleChannels: (guildId: string) =>
    getApi().get<{ channel_ids: string[] }>(`/guilds/${guildId}/channels/visible`),

  // Permission overwrites
  getOverwrites: (channelId: string) =>
    getApi().get<ChannelOverwrite[]>(`/channels/${channelId}/overwrites`),
  upsertOverwrite: (channelId: string, targetId: string, data: UpsertChannelOverwriteRequest) =>
    getApi().put(`/channels/${channelId}/overwrites/${targetId}`, data),
  deleteOverwrite: (channelId: string, targetId: string) =>
    getApi().delete(`/channels/${channelId}/overwrites/${targetId}`),
};
