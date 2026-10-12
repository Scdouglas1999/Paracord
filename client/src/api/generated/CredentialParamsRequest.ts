/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `POST /api/v1/auth/credential/params`.
 */
export interface CredentialParamsRequest {
  /**
   * Username or email, as typed.
   */
  identifier: string;
  [k: string]: unknown | undefined;
}
