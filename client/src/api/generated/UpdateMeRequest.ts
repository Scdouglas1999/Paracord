/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export interface UpdateMeRequest {
  /**
   * Profile accent as `0xRRGGBB`. `null` clears it. Omit the field to leave
   * the stored color unchanged.
   */
  accent_color?: number | null;
  /**
   * Legacy data-URL avatars are still accepted for backward compatibility,
   * but clients should prefer `POST /users/@me/avatar`.
   */
  avatar_hash?: string | null;
  bio?: string | null;
  display_name?: string | null;
  [k: string]: unknown | undefined;
}
