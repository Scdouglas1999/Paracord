/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * Why the desktop app cannot host on this computer (spec §2.3).
 */
export type HostPreflightReason =
  ('no_user_services' | 'no_keychain' | 'existing_server' | 'no_port' | 'no_space') | 'already_hosting';

/**
 * Tauri `host_preflight()`: `{ ok: true, port }` or
 * `{ ok: false, reason, detail?, existing_url? }`; `already_hosting` comes
 * with `ok: true`.
 */
export interface HostPreflight {
  detail?: string | null;
  /**
   * With `existing_server`: the URL to sign in to instead.
   */
  existing_url?: string | null;
  ok: boolean;
  port?: number | null;
  reason?: HostPreflightReason | null;
  [k: string]: unknown | undefined;
}
