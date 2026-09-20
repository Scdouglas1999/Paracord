import { getApi } from './activeClient';
import { resolveServerRootUrl } from '../lib/config/apiBaseUrl';

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

export interface FederationPeerTrustState {
  server_name: string;
  mode: string;
  reason?: string | null;
  quarantined_until_ms?: number | null;
  updated_at_ms: number;
}

export interface FederationModerationSubscription {
  id: string | number;
  source_server?: string | null;
  source_url: string;
  enabled: boolean;
  last_fetch_at_ms?: number | null;
  last_error?: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}


export type HealthSeverity = 'critical' | 'warning' | 'info';

export interface HealthCheck {
  id: string;
  severity: HealthSeverity;
  title: string;
  detail: string;
}

export interface HealthReport {
  version: string;
  uptime_seconds: number;
  database: { engine: string; size_bytes: number | null };
  storage: { uploads_bytes: number; media_bytes: number };
  backups: {
    auto_enabled: boolean;
    interval_seconds: number;
    count: number;
    latest_at: string | null;
    latest_age_hours: number | null;
    total_bytes: number;
  };
  network: {
    bind_address: string;
    public_url: string | null;
    tls_enabled: boolean;
    tls_self_signed: boolean;
    registration_open: boolean;
    federation_enabled: boolean;
  };
  media: { native_enabled: boolean; native_port: number; livekit_available: boolean };
  counts: {
    users: number;
    guilds: number;
    messages: number;
    channels: number;
    online_users: number;
  };
  checks: HealthCheck[];
}

export const adminApi = {
  getHealth: async () => getApi().get<HealthReport>('/admin/health'),
  getStats: async () => getApi().get<{
    total_users: number;
    total_guilds: number;
    total_messages: number;
    total_channels: number;
  }>('/admin/stats'),

  listSecurityEvents: async (params?: { before?: string; limit?: number; action?: string }) =>
    getApi().get<SecurityEvent[]>('/admin/security-events', { params }),

  getSettings: async () => getApi().get<Record<string, string>>('/admin/settings'),

  updateSettings: async (data: Record<string, string>) =>
    getApi().patch<Record<string, string>>('/admin/settings', data),

  getUsers: async (params?: { cursor?: number; offset?: number; limit?: number }) =>
    getApi().get<{
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

  updateUser: async (userId: string, data: { flags: number }) =>
    getApi().patch(`/admin/users/${userId}`, data),

  deleteUser: async (userId: string) =>
    getApi().delete(`/admin/users/${userId}`),

  getGuilds: async () =>
    getApi().get<{
      guilds: Array<{
        id: string;
        name: string;
        description: string | null;
        icon_hash: string | null;
        owner_id: string;
        visibility?: 'private' | 'public' | 'roles';
        created_at: string;
      }>;
    }>('/admin/guilds'),

  updateGuild: async (
    guildId: string,
    data: { name?: string; description?: string; icon?: string; visibility?: 'private' | 'public' }
  ) =>
    getApi().patch<{
      id: string;
      name: string;
      description: string | null;
      icon_hash: string | null;
      owner_id: string;
        visibility?: 'private' | 'public' | 'roles';
      created_at: string;
    }>(`/admin/guilds/${guildId}`, data),

  deleteGuild: async (guildId: string) =>
    getApi().delete(`/admin/guilds/${guildId}`),

  restartUpdate: async () =>
    getApi().post<{ status: string }>('/admin/restart-update'),

  // ── Backups ──────────────────────────────────────────────────────────

  createBackup: async (includeMedia?: boolean) =>
    getApi().post<{ filename: string }>('/admin/backup', {
      include_media: includeMedia ?? true,
    }),

  prepareRestore: async (name: string) =>
    getApi().post<{ status: 'offline_restore_required'; message: string; filename: string; command: string; postgres_argument: string; steps: string[] }>('/admin/restore', {
      name,
    }),

  listBackups: async () =>
    getApi().get<{
      backups: Array<{
        name: string;
        size_bytes: number;
        created_at: string;
      }>;
    }>('/admin/backups'),

  downloadBackup: async (name: string) =>
    getApi().get(`/admin/backups/${encodeURIComponent(name)}`, {
      responseType: 'blob',
      timeout: 300_000, // 5 min timeout for large backups
    }),

  deleteBackup: async (name: string) =>
    getApi().delete(`/admin/backups/${encodeURIComponent(name)}`),

  // Federation server management (admin only)
  listFederatedServers: async () =>
    getApi().get<{ servers: FederatedServer[] }>(
      resolveServerRootUrl('/_paracord/federation/v1/servers')
    ),

  addFederatedServer: async (data: {
    server_name: string;
    domain: string;
    federation_endpoint: string;
    public_key_hex?: string;
    key_id?: string;
    trusted?: boolean;
    discover?: boolean;
  }) =>
    getApi().post(resolveServerRootUrl('/_paracord/federation/v1/servers'), data),

  getFederatedServer: async (serverName: string) =>
    getApi().get<FederatedServer>(
      resolveServerRootUrl(`/_paracord/federation/v1/servers/${encodeURIComponent(serverName)}`)
    ),

  deleteFederatedServer: async (serverName: string) =>
    getApi().delete(
      resolveServerRootUrl(`/_paracord/federation/v1/servers/${encodeURIComponent(serverName)}`)
    ),

  listModerationState: async () =>
    getApi().get<{ states: FederationPeerTrustState[] }>(
      resolveServerRootUrl('/_paracord/federation/v1/moderation/state')
    ),

  applyModerationList: async (data: {
    source: string;
    entries: Array<{
      server_name: string;
      action: string;
      reason?: string;
      quarantine_minutes?: number;
    }>;
  }) =>
    getApi().post<{ source: string; applied: number }>(
      resolveServerRootUrl('/_paracord/federation/v1/moderation/apply'),
      data
    ),

  listModerationSubscriptions: async () =>
    getApi().get<{ subscriptions: FederationModerationSubscription[] }>(
      resolveServerRootUrl('/_paracord/federation/v1/moderation/subscriptions')
    ),

  upsertModerationSubscription: async (data: {
    source_url: string;
    source_server?: string;
    enabled?: boolean;
  }) =>
    getApi().post(
      resolveServerRootUrl('/_paracord/federation/v1/moderation/subscriptions'),
      data
    ),

  deleteModerationSubscription: async (subscriptionId: string) =>
    getApi().delete(
      resolveServerRootUrl(
        `/_paracord/federation/v1/moderation/subscriptions/${encodeURIComponent(subscriptionId)}`
      )
    ),
};
