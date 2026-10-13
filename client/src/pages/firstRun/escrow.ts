import { getPublicKeyAsync } from '@noble/ed25519';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { toB64url, toHex, utf8 } from '../../lib/credential/encoding';

/**
 * The owner's escrow key (docs/setup-spec.md §4.7): the recovery phrase is the
 * identity private key, so the same phrase can later unwrap the server's
 * storage key.
 *
 *   escrow_key = HKDF-SHA256(ikm = identity private key,
 *                            salt = "paracord/host-storage-escrow/v1",
 *                            info = instance_id, L = 32)
 *
 * The same function as `paracord_util::at_rest::derive_escrow_key`; the
 * vector in escrow.test.ts is that crate's.
 */
export const ESCROW_SALT = 'paracord/host-storage-escrow/v1';

export function deriveEscrowKey(identityPrivateKey: Uint8Array, instanceId: string): Uint8Array {
  if (!instanceId) throw new Error('This server has no instance id to bind its escrow to.');
  return hkdf(sha256, identityPrivateKey, utf8(ESCROW_SALT), utf8(instanceId), 32);
}

/** The wire form `host_write_escrow` / `POST /admin/storage-key/escrow` take: b64url of the 32 bytes. */
export function escrowWrappingKey(identityPrivateKey: Uint8Array, instanceId: string): string {
  const key = deriveEscrowKey(identityPrivateKey, instanceId);
  try {
    return toB64url(key);
  } finally {
    key.fill(0);
  }
}

/**
 * The escrow endpoints' body: the wrapping key and the identity public key it
 * was derived from. The server refuses a key that is not the owner's current
 * one (409 `escrow_owner_mismatch`), so an escrow is never sealed under a
 * phrase the owner gave up with "Start over".
 */
export interface EscrowRequest {
  wrapping_key: string;
  owner_public_key: string;
}

export async function escrowRequest(identityPrivateKey: Uint8Array, instanceId: string): Promise<EscrowRequest> {
  const wrapping_key = escrowWrappingKey(identityPrivateKey, instanceId);
  const owner_public_key = toHex(await getPublicKeyAsync(identityPrivateKey));
  return { wrapping_key, owner_public_key };
}
