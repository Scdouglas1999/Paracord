/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export type RelationshipList = Relationship[];

/**
 * `GET /users/@me/relationships` entry. `type` and `rel_type` carry the same
 * relationship kind (1 = friend, 2 = blocked, 3 = pending incoming,
 * 4 = pending outgoing); both names are sent for compatibility.
 */
export interface Relationship {
  created_at: string;
  /**
   * `"<user_id>:<target_id>"`, not a snowflake.
   */
  id: string;
  rel_type: number;
  target_id: string;
  type: number;
  user: RelationshipUser;
  user_id: string;
  [k: string]: unknown | undefined;
}
/**
 * The other party's identity embedded in a relationship entry.
 * Nullable fields are present in responses, including when their value is null.
 */
export interface RelationshipUser {
  avatar_hash: string | null;
  discriminator: number;
  display_name: string | null;
  id: string;
  username: string;
  [k: string]: unknown | undefined;
}
