import { getApi } from './activeClient';
import type { Webhook } from '../types';

interface CreateWebhookRequest {
  name: string;
  channel_id?: string;
}

interface UpdateWebhookRequest {
  name?: string;
}

interface ExecuteWebhookRequest {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: unknown[];
}

interface EditWebhookMessageRequest {
  content?: string;
  embeds?: unknown[];
}

export const webhookApi = {
  create: async (guildId: string, data: CreateWebhookRequest) =>
    getApi().post<Webhook>(`/guilds/${guildId}/webhooks`, data),
  listGuild: async (guildId: string) => getApi().get<Webhook[]>(`/guilds/${guildId}/webhooks`),
  listChannel: async (channelId: string) => getApi().get<Webhook[]>(`/channels/${channelId}/webhooks`),
  get: async (webhookId: string) => getApi().get<Webhook>(`/webhooks/${webhookId}`),
  update: async (webhookId: string, data: UpdateWebhookRequest) =>
    getApi().patch<Webhook>(`/webhooks/${webhookId}`, data),
  delete: async (webhookId: string) => getApi().delete(`/webhooks/${webhookId}`),
  execute: async (webhookId: string, token: string, data: ExecuteWebhookRequest) =>
    getApi().post(`/webhooks/${webhookId}/${token}`, data),
  executeNoWait: async (webhookId: string, token: string, data: ExecuteWebhookRequest) =>
    getApi().post(`/webhooks/${webhookId}/${token}?wait=false`, data),
  editMessage: async (
    webhookId: string,
    token: string,
    messageId: string,
    data: EditWebhookMessageRequest,
  ) => getApi().patch(`/webhooks/${webhookId}/${token}/messages/${messageId}`, data),
  deleteMessage: async (webhookId: string, token: string, messageId: string) =>
    getApi().delete(`/webhooks/${webhookId}/${token}/messages/${messageId}`),
};
