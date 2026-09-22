/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export interface UpdateGuildRequest {
  allowed_roles?: string[] | null;
  bot_settings?: {
    [k: string]: GuildBotConfig | undefined;
  } | null;
  description?: string | null;
  discovery_tags?: string[] | null;
  hub_settings?: HubSettings | null;
  icon?: string | null;
  name?: string | null;
  visibility?: string | null;
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
