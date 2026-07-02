import { getApi } from './activeClient';

export interface GuildStoragePolicy {
  max_file_size: number | null;
  storage_quota: number | null;
  retention_days: number | null;
  allowed_types: string[] | null;
  blocked_types: string[] | null;
}

export interface GuildStorageInfo {
  usage: number;
  quota: number | null;
  policy: GuildStoragePolicy | null;
}

export interface GuildFile {
  id: string;
  filename: string;
  content_type: string | null;
  size: number;
  uploader_id: string | null;
  created_at: string;
}

export const guildStorageApi = {
  getUsage: (guildId: string) =>
    getApi().get<GuildStorageInfo>(`/guilds/${guildId}/storage`),

  updatePolicy: (guildId: string, policy: Partial<GuildStoragePolicy>) =>
    getApi().patch(`/guilds/${guildId}/storage`, policy),

  listFiles: (guildId: string, params?: { before?: string; limit?: number }) =>
    getApi().get<GuildFile[]>(`/guilds/${guildId}/files`, { params }),

  deleteFiles: (guildId: string, ids: string[]) =>
    getApi().delete(`/guilds/${guildId}/files`, { data: { attachment_ids: ids } }),
};
