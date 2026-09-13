/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export interface CreateRelationshipRequest {
  /**
   * Only 1 (friend request) and 2 (block) are accepted.
   */
  type?: number | null;
  user_id?: string | null;
  username?: string | null;
  [k: string]: unknown | undefined;
}
