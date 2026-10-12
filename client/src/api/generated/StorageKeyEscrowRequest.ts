/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `POST /api/v1/host/storage-key/escrow` and
 * `POST /api/v1/admin/storage-key/escrow`: the key that wraps the storage key
 * (spec §4.7). Never stored.
 */
export interface StorageKeyEscrowRequest {
  /**
   * b64url of the 32-byte `escrow_key`.
   */
  wrapping_key: string;
  [k: string]: unknown | undefined;
}
