/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export interface CreateInviteRequest {
  /**
   * Seconds until expiry; 0 means never, at most 604800 (7 days). Defaults to 604800.
   */
  max_age?: number;
  /**
   * 0 means unlimited uses; at most 100 otherwise. Defaults to 25.
   */
  max_uses?: number;
  [k: string]: unknown | undefined;
}
