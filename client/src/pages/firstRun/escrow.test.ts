import { describe, expect, it } from 'vitest';

import vectors from '../../lib/credential/vectors.json';
import { fromHex, toHex } from '../../lib/credential/encoding';
import { deriveEscrowKey, escrowRequest, escrowWrappingKey } from './escrow';

// The shared escrow vector (vectors.reference.mjs; pinned by paracord-util and tests/escrow_vector.rs).
const V = vectors.escrow[0];

describe('the escrow key', () => {
  it('matches the shared vector', () => {
    expect(toHex(deriveEscrowKey(fromHex(V.private_key_hex), V.instance_id))).toBe(V.escrow_key_hex);
    expect(escrowWrappingKey(fromHex(V.private_key_hex), V.instance_id)).toBe(V.wrapping_key);
  });

  it('is bound to the instance and travels as b64url', () => {
    const other = toHex(deriveEscrowKey(fromHex(V.private_key_hex), 'another-instance'));
    expect(other).not.toBe(V.escrow_key_hex);
    expect(escrowWrappingKey(fromHex(V.private_key_hex), V.instance_id)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => deriveEscrowKey(fromHex(V.private_key_hex), '')).toThrow(/instance id/);
  });

  it('names the identity key it was derived from, for the server to check against the owner', async () => {
    const body = await escrowRequest(fromHex(V.private_key_hex), V.instance_id);
    expect(body).toEqual({
      wrapping_key: V.wrapping_key,
      owner_public_key: 'ad1556f6b39cd51a513052c0be97b86e668adb99fadb813e0c02ebddf7037fd4',
    });
  });
});
