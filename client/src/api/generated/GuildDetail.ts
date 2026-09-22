/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export type GuildVisibility = 'private' | 'public' | 'roles';

/**
 * Full settings returned by the space detail and mutation endpoints.
 */
export interface GuildDetail {
  allowed_roles: string[];
  /**
   * `/api/v1/guilds/{id}/banner?v=…` once a banner is uploaded, otherwise null.
   * The version changes with every upload.
   */
  banner_hash: string | null;
  bot_settings: {
    [k: string]: GuildBotConfig | undefined;
  } | null;
  created_at: string;
  description: string | null;
  discovery_tags: string[];
  /**
   * The persisted feature bitset; it is not an array of feature names.
   */
  feature_flags: number;
  hub_settings: HubSettings | null;
  icon_hash: string | null;
  id: string;
  member_count: number;
  name: string;
  owner_id: string;
  system_channel_id: string | null;
  vanity_url_code: string | null;
  visibility: GuildVisibility;
  [k: string]: unknown | undefined;
}
export interface GuildBotConfig {
  enabled?: boolean | null;
  [k: string]: unknown | undefined;
}
export interface HubSettings {
  description?: string | null;
  pinned_channels?: string[] | null;
  welcome_text?: string | null;
  [k: string]: unknown | undefined;
}
