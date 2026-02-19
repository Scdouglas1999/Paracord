import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

const X3DH_INFO = new TextEncoder().encode('paracord:signal:x3dh');
const RATCHET_INFO = new TextEncoder().encode('paracord:signal:ratchet');
const ZEROS_32 = new Uint8Array(32);

/**
 * X3DH key derivation: HKDF-SHA256 with zero salt.
 * Input: concatenated DH outputs.
 * Output: 32-byte shared secret (SK).
 */
export function x3dhKDF(dhConcat: Uint8Array): Uint8Array {
  return hkdf(sha256, dhConcat, ZEROS_32, X3DH_INFO, 32);
}

/**
 * Root key KDF for the Double Ratchet.
 * Uses the current root key as HKDF salt.
 * Returns new {rootKey, chainKey} (32 bytes each).
 */
export function kdfRK(
  rk: Uint8Array,
  dhOutput: Uint8Array,
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const output = hkdf(sha256, dhOutput, rk, RATCHET_INFO, 64);
  return {
    rootKey: output.slice(0, 32),
    chainKey: output.slice(32, 64),
  };
}

/**
 * Chain key KDF for the Double Ratchet.
 * Derives the next chain key and a message key from the current chain key.
 */
export function kdfCK(
  ck: Uint8Array,
): { chainKey: Uint8Array; messageKey: Uint8Array } {
  const messageKey = hmac(sha256, ck, new Uint8Array([0x01]));
  const chainKey = hmac(sha256, ck, new Uint8Array([0x02]));
  return { chainKey, messageKey };
}
