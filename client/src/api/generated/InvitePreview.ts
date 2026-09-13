/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `GET /invites/{code}`: public invite resolution. `guild` is null when the
 * invite's channel no longer resolves to a guild.
 */
export interface InvitePreview {
  code: string;
  guild: InviteGuildPreview | null;
  [k: string]: unknown | undefined;
}
/**
 * The guild card embedded in `GET /invites/{code}`.
 */
export interface InviteGuildPreview {
  icon_hash: string | null;
  id: string;
  member_count: number;
  name: string;
  [k: string]: unknown | undefined;
}
