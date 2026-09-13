import { getApi } from './activeClient';
import type { RestClient } from './restClient';
import type { Channel } from '../types';

export function createDmApi(getApi: () => RestClient) { return {
  list: async () => getApi().get<Channel[]>('/users/@me/dms'),
  create: async (recipientId: string) =>
    getApi().post<Channel>('/users/@me/dms', { recipient_id: recipientId }),
  createGroup: async (recipientIds: string[], name?: string) =>
    getApi().post<Channel>('/users/@me/channels', { recipient_ids: recipientIds, name }),
  listRecipients: async (channelId: string) =>
    getApi().get<Array<{ id: string; username: string; discriminator: number; avatar_hash?: string; public_key?: string | null }>>(
      `/channels/${channelId}/recipients`
    ),
  addRecipient: async (channelId: string, userId: string) =>
    getApi().put(`/channels/${channelId}/recipients/${userId}`),
  removeRecipient: async (channelId: string, userId: string) =>
    getApi().delete(`/channels/${channelId}/recipients/${userId}`),
}; }

export const dmApi = createDmApi(getApi);
