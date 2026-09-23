/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `GET /users/{user_id}/profile`: the public profile card. When the subject
 * has blocked the viewer the server returns the same shape with profile
 * extras nulled out and empty relationship lists.
 */
export interface PublicUserProfile {
  created_at: string;
  mutual_friends: MutualFriend[];
  mutual_guilds: MutualGuild[];
  roles: ProfileRole[];
  user: PublicUser;
  [k: string]: unknown | undefined;
}
/**
 * A friend shared by the viewer and the profile subject.
 */
export interface MutualFriend {
  avatar_hash: string | null;
  discriminator: number;
  id: string;
  username: string;
  [k: string]: unknown | undefined;
}
/**
 * A guild shared by the viewer and the profile subject. `icon_url` is the
 * persisted icon hash; the wire name predates the `icon_hash` convention.
 */
export interface MutualGuild {
  icon_url: string | null;
  id: string;
  name: string;
  [k: string]: unknown | undefined;
}
/**
 * A guild role embedded in the public profile response. `permissions` is the
 * bitset as a decimal string, preserving values beyond JavaScript's safe
 * integer range.
 */
export interface ProfileRole {
  color: number;
  created_at: string;
  guild_id: string;
  hoist: boolean;
  id: string;
  mentionable: boolean;
  name: string;
  permissions: string;
  position: number;
  [k: string]: unknown | undefined;
}
/**
 * The user object embedded in the public profile response.
 */
export interface PublicUser {
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
  flags: number;
  id: string;
  linked_accounts: LinkedAccount[];
  pronouns: string | null;
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
