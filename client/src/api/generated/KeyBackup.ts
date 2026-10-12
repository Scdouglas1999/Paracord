/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `GET /api/v1/users/@me/key-backup`.
 */
export interface KeyBackup {
  epoch: number;
  /**
   * hex.
   */
  public_key: string;
  /**
   * The person ticked "I wrote it down" for the recovery phrase.
   */
  recovery_confirmed: boolean;
  wrap_alg: string;
  /**
   * b64url.
   */
  wrapped_key: string;
  [k: string]: unknown | undefined;
}
