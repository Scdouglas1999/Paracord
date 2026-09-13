/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `GET`/`PATCH /users/@me/settings`. The server stores `theme`, `locale`, and
 * `status` as opaque strings (bounded by length only), and `notifications` and
 * `keybinds` as free-form JSON objects; they are echoed verbatim.
 */
export interface UserSettingsResponse {
  crypto_auth_enabled: boolean;
  custom_css: string | null;
  custom_status: string | null;
  keybinds: {
    [k: string]: unknown | undefined;
  };
  locale: string;
  message_display_compact: boolean;
  notifications: {
    [k: string]: unknown | undefined;
  };
  status: string;
  theme: string;
  user_id: string;
  [k: string]: unknown | undefined;
}
