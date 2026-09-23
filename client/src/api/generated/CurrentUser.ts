/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `GET /users/@me`: the authenticated account, including credential metadata.
 */
export interface CurrentUser {
  /**
   * Profile accent as `0xRRGGBB`. Omitted when the member has not chosen one.
   *
   * New in 3.2. Unlike the other nullable fields it may be absent rather
   * than null, so a 3.2 client can still read accounts from a 3.1 instance,
   * which never sends it.
   */
  accent_color?: number | null;
  avatar_hash: string | null;
  banner_hash: string | null;
  bio: string | null;
  bot: boolean;
  created_at: string;
  discriminator: number;
  display_name: string | null;
  email: string;
  email_verified: boolean;
  flags: number;
  has_public_key: boolean;
  id: string;
  linked_accounts: LinkedAccount[];
  pronouns: string | null;
  /**
   * An attached Ed25519 key can authenticate this account on its own, so the
   * owner must be able to see that one exists and which one it is.
   */
  public_key: string | null;
  system: boolean;
  username: string;
  [k: string]: unknown | undefined;
}
/**
 * A linked account published on a user's public profile.
 */
export interface LinkedAccount {
  label: string;
  url: string;
  [k: string]: unknown | undefined;
}
