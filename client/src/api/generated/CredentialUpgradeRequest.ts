/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `POST /api/v1/auth/credential/upgrade`: move a legacy (v1) account to one
 * password (spec §3.11).
 */
export interface CredentialUpgradeRequest {
  credential: NewCredential;
  /**
   * The legacy sign-in password, which the server checks as today.
   */
  current_password: string;
  identity: NewIdentity;
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
 * The identity as the server keeps it: the public key and the private key
 * wrapped under the password-derived wrap key.
 */
export interface NewIdentity {
  proof: IdentityProof;
  /**
   * hex of the 32-byte Ed25519 public key.
   */
  public_key: string;
  /**
   * `"aes256gcm-v2"` ([`WRAP_ALG_V2`]).
   */
  wrap_alg: string;
  /**
   * b64url of `iv12 || ciphertext+tag` (12 + 48 bytes).
   */
  wrapped_key: string;
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
