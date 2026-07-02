import { getApi } from './activeClient';

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
  list: () => getApi().get<GuildTemplate[]>('/templates'),
  apply: (templateId: string, name: string) =>
    getApi().post(`/templates/${templateId}/apply`, { name }),
  remove: (templateId: string) => getApi().delete(`/templates/${templateId}`),
  createFromGuild: (guildId: string) => getApi().post(`/guilds/${guildId}/template`),
};

