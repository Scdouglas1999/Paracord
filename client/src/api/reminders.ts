import type { Message } from '../types';
import { getApi } from './activeClient';
import { hasListField, responseContract } from './responseContracts';

export interface ReminderItem {
  id: string;
  remind_at: string;
  created_at: string;
  fired_at: string | null;
  channel: {
    id: string;
    name: string | null;
    guild_id?: string | null;
  };
  message: Message;
  preview: string | null;
}

export interface ReactionPerson {
  id: string;
  username: string;
  display_name: string | null;
  avatar_hash: string | null;
}

export const remindersApi = {
  list: async () => responseContract(
    getApi().get<unknown>('/users/@me/reminders'),
    hasListField<{ items: ReminderItem[] }>('items'),
    'reminder list',
  ),
  put: async (channelId: string, messageId: string, remindAt: string) =>
    getApi().put<ReminderItem>(`/channels/${channelId}/messages/${messageId}/reminder`, {
      remind_at: remindAt,
    }),
  remove: async (channelId: string, messageId: string) =>
    getApi().delete(`/channels/${channelId}/messages/${messageId}/reminder`),
};

export const reactionUsersApi = {
  list: async (channelId: string, messageId: string, emoji: string, limit = 100, after?: string) =>
    getApi().get<ReactionPerson[]>(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { params: { limit, ...(after ? { after } : {}) } },
    ),
};
