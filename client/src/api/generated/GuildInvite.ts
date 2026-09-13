/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * A guild invite as returned by create and guild-scoped list endpoints.
 * Nullable fields are present in responses, including when their value is null.
 * `max_uses`/`max_age` of 0 mean unlimited/never expire.
 */
export interface GuildInvite {
  channel_id: string;
  code: string;
  created_at: string;
  guild_id: string;
  inviter_id: string | null;
  max_age: number | null;
  max_uses: number | null;
  uses: number;
  [k: string]: unknown | undefined;
}
