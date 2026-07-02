import { apiClient } from './client';

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

export const templateApi = {
  list: () => apiClient.get<GuildTemplate[]>('/templates'),
  apply: (templateId: string, name: string) =>
    apiClient.post(`/templates/${templateId}/apply`, { name }),
  remove: (templateId: string) => apiClient.delete(`/templates/${templateId}`),
  createFromGuild: (guildId: string) => apiClient.post(`/guilds/${guildId}/template`),
};

