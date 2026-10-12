/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `POST /api/v1/auth/credential/login`. The response is the same
 * `LoginResponse` as `/auth/login`, including its MFA ticket branch.
 */
export interface CredentialLoginRequest {
  /**
   * b64url of the 32-byte auth key.
   */
  auth_key: string;
  identifier: string;
  [k: string]: unknown | undefined;
}
