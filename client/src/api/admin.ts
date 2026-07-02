import { apiClient } from './client';
import { resolveServerRootUrl } from '../lib/apiBaseUrl';

export interface SecurityEvent {
  id: string;
  actor_user_id?: string | null;
  action: string;
  target_user_id?: string | null;
  session_id?: string | null;
  device_id?: string | null;
  user_agent?: string | null;
  ip_address?: string | null;
  details?: Record<string, unknown> | null;
  created_at: string;
}

export interface FederatedServer {
  id: string;
  server_name: string;
  domain: string;
  federation_endpoint: string;
  public_key_hex?: string | null;
  key_id?: string | null;
  trusted: boolean;
  last_seen_at?: string | null;
  created_at: string;
}

export const adminApi = {
  getStats: () => apiClient.get<{
    total_users: number;
    total_guilds: number;
    total_messages: number;
    total_channels: number;
  }>('/admin/stats'),

  listSecurityEvents: (params?: { before?: string; limit?: number; action?: string }) =>
    apiClient.get<SecurityEvent[]>('/admin/security-events', { params }),

  getSettings: () => apiClient.get<Record<string, string>>('/admin/settings'),

  updateSettings: (data: Record<string, string>) =>
    apiClient.patch<Record<string, string>>('/admin/settings', data),

  getUsers: (params?: { cursor?: number; offset?: number; limit?: number }) =>
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
      cursor: number | null;
      next_cursor: number | null;
      offset: number | null;
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

  // ── Backups ──────────────────────────────────────────────────────────

  createBackup: (includeMedia?: boolean) =>
    apiClient.post<{ filename: string }>('/admin/backup', {
      include_media: includeMedia ?? true,
    }),

  restoreBackup: (name: string) =>
    apiClient.post<{ message: string; filename: string }>('/admin/restore', {
      name,
    }),

  listBackups: () =>
    apiClient.get<{
      backups: Array<{
        name: string;
        size_bytes: number;
        created_at: string;
      }>;
    }>('/admin/backups'),

  downloadBackup: (name: string) =>
    apiClient.get(`/admin/backups/${encodeURIComponent(name)}`, {
      responseType: 'blob',
      timeout: 300_000, // 5 min timeout for large backups
    }),

  deleteBackup: (name: string) =>
    apiClient.delete(`/admin/backups/${encodeURIComponent(name)}`),

  // Federation server management (admin only)
  listFederatedServers: () =>
    apiClient.get<{ servers: FederatedServer[] }>(
      resolveServerRootUrl('/_paracord/federation/v1/servers')
    ),

  addFederatedServer: (data: {
    server_name: string;
    domain: string;
    federation_endpoint: string;
    public_key_hex?: string;
    key_id?: string;
    trusted?: boolean;
    discover?: boolean;
  }) =>
    apiClient.post(resolveServerRootUrl('/_paracord/federation/v1/servers'), data),

  getFederatedServer: (serverName: string) =>
    apiClient.get<FederatedServer>(
      resolveServerRootUrl(`/_paracord/federation/v1/servers/${encodeURIComponent(serverName)}`)
    ),

  deleteFederatedServer: (serverName: string) =>
    apiClient.delete(
      resolveServerRootUrl(`/_paracord/federation/v1/servers/${encodeURIComponent(serverName)}`)
    ),
};
