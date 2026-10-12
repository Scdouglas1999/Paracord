/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * Who enforces the password rules.
 */
export type PasswordRulesEnforcedBy = 'client' | 'server';

/**
 * `GET /api/v1/setup/password-requirements` (spec §3.4).
 */
export interface PasswordRequirements {
  enforced_by?: PasswordRulesEnforcedBy;
  /**
   * `"utf8_bytes"`.
   */
  length_unit: string;
  max_length: number;
  min_length: number;
  requires_digit: boolean;
  requires_lowercase: boolean;
  requires_symbol: boolean;
  requires_uppercase: boolean;
  [k: string]: unknown | undefined;
}
