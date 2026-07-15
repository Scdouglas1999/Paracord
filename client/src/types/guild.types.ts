import type { Channel } from './channel.types';
import type { User } from './user.types';

export interface HubSettings {
  description?: string;
  banner_hash?: string;
  pinned_channels?: string[];
  welcome_text?: string;
  [key: string]: unknown;
}

export interface GuildBotConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface Guild {
  id: string;
  name: string;
  icon?: string;
  icon_hash?: string | null;
  banner?: string;
  banner_hash?: string;
  description?: string;
  owner_id: string;
  member_count: number;
  features: string[];
  system_channel_id?: string;
  rules_channel_id?: string;
  default_channel_id?: string | null;
  vanity_url_code?: string;
  created_at: string;
  visibility?: 'private' | 'public' | 'roles';
  allowed_roles?: string[];
  discovery_tags?: string[];
  hub_settings?: HubSettings;
  bot_settings?: Record<string, GuildBotConfig>;
  /** Base URL of the server this guild was fetched from (client-side tag). */
  server_url?: string;
  /**
   * Connection id of the server this guild actually originated from (client-side
   * tag, stamped at gateway ingest). Unlike `server_url` — which `addGuild`
   * defaults to the ACTIVE server's base url and so mis-attributes guilds that
   * arrive over a background server's READY — this carries the true owning
   * server, so the cross-server merge reads unread/mention from the right bucket
   * (layout-spec §9 flag 3).
   */
  originServerId?: string;
}

export interface Member {
  user: User;
  user_id?: string;
  guild_id?: string;
  nick?: string | null;
  roles: string[];
  joined_at: string;
  deaf: boolean;
  mute: boolean;
}

export interface Role {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string | number;
  mentionable: boolean;
  created_at: string;
}

export interface Invite {
  code: string;
  guild_id: string;
  channel_id: string;
  inviter_id?: string;
  uses: number;
  max_uses?: number;
  max_age?: number;
  temporary: boolean;
  created_at: string;
  guild?: Guild;
  channel?: Channel;
  inviter?: User;
}

export interface Webhook {
  id: string;
  guild_id: string;
  channel_id: string;
  name: string;
  creator_id?: string | null;
  created_at: string;
  token?: string;
}

export interface GuildEmoji {
  id: string;
  guild_id: string;
  name: string;
  animated: boolean;
  creator_id?: string | null;
  created_at: string;
}

export interface Ban {
  user: User;
  user_id?: string;
  reason?: string | null;
  guild_id: string;
  banned_by?: string | null;
  created_at?: string;
}

export interface AuditLogEntry {
  id: string;
  guild_id: string;
  user_id: string;
  action_type: number;
  target_id?: string;
  changes?: Record<string, unknown>;
  reason?: string;
  created_at: string;
}

export interface ModerationReport {
  id: string;
  guild_id: string;
  reporter_id: string;
  action_type: number;
  status:
    | 'open'
    | 'dismissed'
    | 'warned'
    | 'muted'
    | 'banned'
    | 'approved'
    | 'rejected'
    | string;
  target_id?: string;
  reason?: string;
  changes?: Record<string, unknown>;
  created_at: string;
}

export interface CreateReportRequest {
  target_type: 'message' | 'user' | 'guild';
  target_id: string;
  reason: string;
  message_id?: string;
  channel_id?: string;
  reported_user_id?: string;
  evidence?: string[];
}

export interface ResolveReportRequest {
  action: 'dismiss' | 'warn' | 'mute' | 'ban' | 'approve' | 'reject';
  note?: string;
  mute_minutes?: number;
}
