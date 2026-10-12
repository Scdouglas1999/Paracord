/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

export type CredentialParams =
  | {
      version: 1;
      [k: string]: unknown | undefined;
    }
  | {
      epoch: number;
      kdf: KdfParams;
      salt: string;
      version: 2;
      [k: string]: unknown | undefined;
    };

/**
 * scrypt parameters as sent on the wire. Stored per credential as
 * `"scrypt:<log_n>:<r>:<p>"` (see [`KdfParams::to_db_text`]).
 */
export interface KdfParams {
  /**
   * Always `"scrypt"`.
   */
  alg: string;
  /**
   * log2 of scrypt's N.
   */
  log_n: number;
  p: number;
  r: number;
  [k: string]: unknown | undefined;
}
