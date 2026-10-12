import { describe, expect, it } from 'vitest';

import { fromHex, toHex } from '../../lib/credential/encoding';
import { deriveEscrowKey, escrowWrappingKey } from './escrow';

// paracord_util::at_rest tests: the S1 vector identity and the escrow key node:crypto derives.
const IDENTITY = 'd2cb3a96fd540c24f68825716fdb1e8c2549542d67fd5d25107635c2959f8d9c';
const INSTANCE = '7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a';
const ESCROW = '03976eb9f4df480870ebee2d4d495ad22dcc239d87193d5fb9382ef36f2388cf';

describe('the escrow key', () => {
  it('matches the server crate vector', () => {
    expect(toHex(deriveEscrowKey(fromHex(IDENTITY), INSTANCE))).toBe(ESCROW);
  });

  it('is bound to the instance and travels as b64url', () => {
    const other = toHex(deriveEscrowKey(fromHex(IDENTITY), 'another-instance'));
    expect(other).not.toBe(ESCROW);
    expect(escrowWrappingKey(fromHex(IDENTITY), INSTANCE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => deriveEscrowKey(fromHex(IDENTITY), '')).toThrow(/instance id/);
  });
});
