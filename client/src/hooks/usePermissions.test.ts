import { describe, expect, it } from 'vitest';
import { toPermissionBits } from './usePermissions';

describe('toPermissionBits', () => {
  it('returns 0n for null/undefined', () => {
    expect(toPermissionBits(undefined)).toBe(0n);
    expect(toPermissionBits(undefined as unknown as string)).toBe(0n);
  });

  it('parses a full 64-bit permission string without truncation', () => {
    // 2^63 - 1: well beyond Number.MAX_SAFE_INTEGER (2^53 - 1). parseInt+BigInt
    // would have truncated the low bits; BigInt(string) preserves them exactly.
    expect(toPermissionBits('9223372036854775807')).toBe(9223372036854775807n);
  });

  it('preserves a bit above 2^53', () => {
    expect(toPermissionBits('9007199254740993')).toBe(9007199254740993n);
  });

  it('returns 0n for a malformed string', () => {
    expect(toPermissionBits('not-a-number')).toBe(0n);
    expect(toPermissionBits('12abc')).toBe(0n);
  });

  it('handles numeric input', () => {
    expect(toPermissionBits(8)).toBe(8n);
    expect(toPermissionBits(0)).toBe(0n);
  });
});
