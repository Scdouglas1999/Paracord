import { getApi } from './activeClient';
import type { Channel } from '../types';

export const dmApi = {
  list: () => getApi().get<Channel[]>('/users/@me/dms'),
  create: (recipientId: string) =>
    getApi().post<Channel>('/users/@me/dms', { recipient_id: recipientId }),
  createGroup: (recipientIds: string[], name?: string) =>
    getApi().post<Channel>('/users/@me/channels', { recipient_ids: recipientIds, name }),
  listRecipients: (channelId: string) =>
    getApi().get<Array<{ id: string; username: string; discriminator: number; avatar_hash?: string; public_key?: string | null }>>(
      `/channels/${channelId}/recipients`
    ),
  addRecipient: (channelId: string, userId: string) =>
    getApi().put(`/channels/${channelId}/recipients/${userId}`),
  removeRecipient: (channelId: string, userId: string) =>
    getApi().delete(`/channels/${channelId}/recipients/${userId}`),
};
