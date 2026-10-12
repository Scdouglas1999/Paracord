/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `PUT /api/v1/users/@me/credential`: change the password (spec §3.7).
 */
export interface ChangeCredentialRequest {
  credential: NewCredential;
  /**
   * b64url auth key derived from the current password.
   */
  current_auth_key: string;
  mfa_code?: string | null;
  /**
   * The same identity, wrapped under the new password's wrap key.
   */
  wrapped_key: string;
  [k: string]: unknown | undefined;
}
/**
 * A freshly derived credential: what the server stores in place of a password.
 */
export interface NewCredential {
  /**
   * b64url of the 32-byte HKDF output `paracord/credential/v2/auth`.
   */
  auth_key: string;
  kdf: KdfParams;
  /**
   * b64url of 32 random bytes.
   */
  salt: string;
  [k: string]: unknown | undefined;
}
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
