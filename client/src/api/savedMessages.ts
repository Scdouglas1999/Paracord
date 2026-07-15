import type { Message } from '../types';
import { getApi } from './activeClient';

export interface SavedMessageItem {
  message: Message;
  saved_at: string;
  channel: {
    id: string;
    name: string;
    guild_id?: string | null;
  };
}

export interface SavedMessagesResponse {
  items: SavedMessageItem[];
  total: number;
}

export const savedMessagesApi = {
  list: (limit = 50) =>
    getApi().get<SavedMessagesResponse>('/users/@me/saved-messages', { params: { limit } }),
  save: (messageId: string) =>
    getApi().put<{ message_id: string; saved_at: string }>(`/users/@me/saved-messages/${messageId}`),
  remove: (messageId: string) =>
    getApi().delete(`/users/@me/saved-messages/${messageId}`),
};
