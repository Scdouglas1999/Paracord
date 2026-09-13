/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export type GuildVisibility = 'private' | 'public' | 'roles';

/**
 * Space metadata used by the authenticated space list and navigation.
 * Nullable fields are present in responses, including when their value is null.
 */
export interface GuildSummary {
  allowed_roles: string[];
  bot_settings: {
    [k: string]: GuildBotConfig | undefined;
  } | null;
  created_at: string;
  description: string | null;
  discovery_tags: string[];
  hub_settings: HubSettings | null;
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
  banner_hash?: string | null;
  description?: string | null;
  pinned_channels?: string[] | null;
  welcome_text?: string | null;
  [k: string]: unknown | undefined;
}
