/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `POST /api/v1/users/@me/credential/reset`: a new password after signing in
 * with the recovery phrase (spec §3.8). `proof` signs a fresh challenge with
 * purpose `paracord/credential/v2/reset`.
 */
export interface ResetCredentialRequest {
  credential: NewCredential;
  mfa_code?: string | null;
  proof: IdentityProof;
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
/**
 * A signature over a server challenge, proving possession of the identity key.
 */
export interface IdentityProof {
  /**
   * The nonce `/auth/challenge` issued.
   */
  nonce: string;
  /**
   * hex Ed25519 signature over
   * `"<purpose>:" + nonce + ":" + timestamp + ":" + origin`, where purpose is
   * `paracord/credential/v2/register` or `paracord/credential/v2/reset`.
   */
  signature: string;
  /**
   * The timestamp `/auth/challenge` issued (Unix seconds).
   */
  timestamp: number;
  [k: string]: unknown | undefined;
}
