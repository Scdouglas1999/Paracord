/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export type GuildVisibility = 'private' | 'public' | 'roles';
export type GuildSummaryList = GuildSummary[];

/**
 * Space metadata used by the authenticated space list and navigation.
 * Nullable fields are present in responses, including when their value is null.
 */
export interface GuildSummary {
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
