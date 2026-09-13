/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `POST /invites/{code}` response.
 */
export interface InviteAcceptResponse {
  guild: InviteAcceptGuild;
  [k: string]: unknown | undefined;
}
/**
 * The guild card returned after successfully accepting an invite.
 */
export interface InviteAcceptGuild {
  created_at: string;
  /**
   * First usable channel for post-join navigation.
   */
  default_channel_id: string | null;
  description: string | null;
  icon_hash: string | null;
  id: string;
  member_count: number;
  name: string;
  owner_id: string;
  [k: string]: unknown | undefined;
}
