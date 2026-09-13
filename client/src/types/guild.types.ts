import type { User } from './user.types';

import type { GuildDetail } from '../api/generated/GuildDetail';
export type { HubSettings, GuildBotConfig } from '../api/generated/GuildDetail';

// JSON responses can add unknown fields for forward compatibility. Those index
// signatures do not describe a named field in the app's partial projection.
type KnownFields<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
};
type DetailFields = KnownFields<GuildDetail>;
type GuildIdentityFields = Pick<DetailFields, 'id' | 'name' | 'owner_id' | 'member_count'>;

/** A space projection can begin with the smaller authenticated READY payload. */
export interface Guild extends GuildIdentityFields, Partial<Omit<DetailFields, keyof GuildIdentityFields>> {
  /** Older gateway payloads used icon; full REST responses use icon_hash. */
  icon?: string;
  default_channel_id?: string | null;
  /** Base URL of the server this guild was fetched from (client-side tag). */
  server_url?: string;
  /** Connection that supplied this projection, independent of current selection. */
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

/** Matches the `GuildInvite` wire contract; the server never sent the nested
 * guild/channel/inviter or `temporary` fields the old shape claimed. */
export interface Invite {
  code: string;
  guild_id: string;
  channel_id: string;
  inviter_id: string | null;
  uses: number;
  max_uses: number | null;
  max_age: number | null;
  created_at: string;
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
