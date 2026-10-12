/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export interface UpdateSettingsRequest {
  crypto_auth_enabled?: boolean | null;
  custom_css?: string | null;
  custom_status?: string | null;
  keybinds?: unknown;
  /**
   * Whether links this person posts are unfurled into previews, and whether
   * they see previews (spec §8.3). Stored in `user_settings.link_previews`.
   */
  link_previews?: boolean | null;
  locale?: string | null;
  message_display_compact?: boolean | null;
  notifications?: unknown;
  status?: string | null;
  theme?: string | null;
  [k: string]: unknown | undefined;
}
