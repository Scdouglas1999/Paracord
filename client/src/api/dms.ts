import { apiClient } from './client';
import type { Channel } from '../types';

export const dmApi = {
  list: () => apiClient.get<Channel[]>('/users/@me/dms'),
  create: (recipientId: string) =>
    apiClient.post<Channel>('/users/@me/dms', { recipient_id: recipientId }),
  createGroup: (recipientIds: string[], name?: string) =>
    apiClient.post<Channel>('/users/@me/channels', { recipient_ids: recipientIds, name }),
  listRecipients: (channelId: string) =>
    apiClient.get<Array<{ id: string; username: string; discriminator: number; avatar_hash?: string; public_key?: string | null }>>(
      `/channels/${channelId}/recipients`
    ),
  addRecipient: (channelId: string, userId: string) =>
    apiClient.put(`/channels/${channelId}/recipients/${userId}`),
  removeRecipient: (channelId: string, userId: string) =>
    apiClient.delete(`/channels/${channelId}/recipients/${userId}`),
};
