/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `PATCH /users/@me` and `POST /users/@me/avatar`: the updated account fields.
 * Settings-derived extras (pronouns, linked accounts) and key metadata are
 * only returned by `GET /users/@me`.
 */
export interface UpdatedCurrentUser {
  avatar_hash: string | null;
  banner_hash: string | null;
  bio: string | null;
  bot: boolean;
  created_at: string;
  discriminator: number;
  display_name: string | null;
  email: string;
  flags: number;
  id: string;
  system: boolean;
  username: string;
  [k: string]: unknown | undefined;
}
