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
   * The version changes with every upload. This server always sends it; it
   * is optional in the contract because servers older than 3.2 (no banners)
   * leave it out of the summary, and absent reads exactly as null.
   */
  banner_hash?: string | null;
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
  /**
   * The server's color as a hue, 0-359. Null when unset; clients then
   * derive one from the id. This server always sends it. It is optional in
   * the contract for protocol-version tolerance: a server from before
   * server colors leaves it out, which a client reads as null (no color
   * picked) and as "this server cannot store a color".
   */
  hue?: number | null;
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
