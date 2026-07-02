import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildIdentityVerificationPayload,
  formatIdentityFingerprint,
  isIdentityVerified,
  markIdentityVerified,
  observeIdentityFingerprint,
  parseIdentityVerificationPayload,
} from './keyVerification';

vi.mock('./secureStorage', () => {
  const store = new Map<string, string>();
  return {
    secureGet: vi.fn(async (key: string) => store.get(key) ?? null),
    secureSet: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    secureDelete: vi.fn(async (key: string) => { store.delete(key); }),
    __store: store,
  };
});

describe('keyVerification', () => {
  beforeEach(async () => {
    localStorage.clear();
    const mod = await import('./secureStorage') as unknown as { __store: Map<string, string> };
    mod.__store.clear();
  });

  it('formats fingerprint into grouped hex', () => {
    const fp = formatIdentityFingerprint('AABBCCDDEEFF00112233445566778899');
    expect(fp).toBe('aabb ccdd eeff 0011 2233 4455 6677 8899');
  });

  it('detects key rotation and clears verified state', async () => {
    const first = await observeIdentityFingerprint('user-1', 'aaaa bbbb');
    expect(first.rotated).toBe(false);

    await markIdentityVerified('user-1', 'aaaa bbbb');
    expect(await isIdentityVerified('user-1', 'aaaa bbbb')).toBe(true);

    const second = await observeIdentityFingerprint('user-1', 'cccc dddd');
    expect(second.rotated).toBe(true);
    expect(second.previousFingerprint).toBe('aaaa bbbb');
    expect(await isIdentityVerified('user-1', 'cccc dddd')).toBe(false);
  });

  it('builds and parses verification payload', () => {
    const payload = buildIdentityVerificationPayload('user-2', 'alice', 'ffff 1111');
    const parsed = parseIdentityVerificationPayload(payload);
    expect(parsed).toEqual({
      userId: 'user-2',
      username: 'alice',
      fingerprint: 'ffff 1111',
    });
  });
});
