import { apiClient } from './client';

export const adminApi = {
  getStats: () => apiClient.get<{
    total_users: number;
    total_guilds: number;
    total_messages: number;
    total_channels: number;
  }>('/admin/stats'),

  getSettings: () => apiClient.get<Record<string, string>>('/admin/settings'),

  updateSettings: (data: Record<string, string>) =>
    apiClient.patch<Record<string, string>>('/admin/settings', data),

  getUsers: (params?: { offset?: number; limit?: number }) =>
    apiClient.get<{
      users: Array<{
        id: string;
        username: string;
        discriminator: number;
        email: string;
        display_name: string | null;
        avatar_hash: string | null;
        flags: number;
        created_at: string;
      }>;
      total: number;
      offset: number;
      limit: number;
    }>('/admin/users', { params }),

  updateUser: (userId: string, data: { flags: number }) =>
    apiClient.patch(`/admin/users/${userId}`, data),

  deleteUser: (userId: string) =>
    apiClient.delete(`/admin/users/${userId}`),

  getGuilds: () =>
    apiClient.get<{
      guilds: Array<{
        id: string;
        name: string;
        description: string | null;
        icon_hash: string | null;
        owner_id: string;
        created_at: string;
      }>;
    }>('/admin/guilds'),

  updateGuild: (
    guildId: string,
    data: { name?: string; description?: string; icon?: string }
  ) =>
    apiClient.patch<{
      id: string;
      name: string;
      description: string | null;
      icon_hash: string | null;
      owner_id: string;
      created_at: string;
    }>(`/admin/guilds/${guildId}`, data),

  deleteGuild: (guildId: string) =>
    apiClient.delete(`/admin/guilds/${guildId}`),

  restartUpdate: () =>
    apiClient.post<{ status: string }>('/admin/restart-update'),
};
