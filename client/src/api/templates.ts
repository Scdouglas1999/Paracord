import type { Guild } from '../types';
import { getApi as getActiveApi } from './activeClient';
import type { RestClient } from './restClient';

export interface GuildTemplate {
  id: string;
  name: string;
  description: string;
  creator_id: string;
  source_guild_id: string | null;
  template_data: {
    channels: { name: string; type: number; position: number; parent_name: string | null }[];
    roles: { name: string; permissions: string; color: number; position: number }[];
  };
  usage_count: number;
  created_at: string;
}

export function createTemplateApi(getApi: () => RestClient) {
  return {
  list: async () => getApi().get<GuildTemplate[]>('/templates'),
  apply: async (templateId: string, name: string) =>
    getApi().post<Guild>(`/templates/${templateId}/apply`, { name }),
  remove: async (templateId: string) => getApi().delete(`/templates/${templateId}`),
  createFromGuild: async (guildId: string) => getApi().post(`/guilds/${guildId}/template`),
  };
}

export const templateApi = createTemplateApi(getActiveApi);
