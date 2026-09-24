import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptIdentityRotation,
  assertPinnedDmPeerIdentity,
  assertPinnedIdentityKey,
  assertPinnedIdentityKeys,
  buildIdentityVerificationPayload,
  formatIdentityFingerprint,
  getDmPeerIdentityPin,
  getPendingIdentityRotation,
  IdentityPinError,
  isIdentityVerified,
  markIdentityVerified,
  observeIdentityFingerprint,
  parseIdentityVerificationPayload,
  getIdentityTrustState,
  IdentityTrustLockedError,
} from './keyVerification';
import { installIdentityTrustVault, resetIdentityTrust } from '../test/identityTrustVaultMock';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

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
    resetIdentityTrust();
    installIdentityTrustVault();
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

  it('keeps the pin on rotation instead of rolling it forward', async () => {
    // Observing a new key twice must not be enough to retire the pinned one —
    // that would let a hostile server replace it just by serving it again.
    await observeIdentityFingerprint('user-9', 'aaaa');
    const first = await observeIdentityFingerprint('user-9', 'bbbb');
    expect(first.rotated).toBe(true);
    const second = await observeIdentityFingerprint('user-9', 'bbbb');
    expect(second.rotated).toBe(true);
    expect(second.previousFingerprint).toBe('aaaa');
  });

  describe('pin enforcement', () => {
    it('pins on first sight and accepts the same key afterwards', async () => {
      await expect(assertPinnedIdentityKey('user-1', KEY_A)).resolves.toBe(
        formatIdentityFingerprint(KEY_A),
      );
      await expect(assertPinnedIdentityKey('user-1', KEY_A)).resolves.toBeTruthy();
    });

    it('fails closed when the identity key rotates', async () => {
      await assertPinnedIdentityKey('user-1', KEY_A);
      await expect(assertPinnedIdentityKey('user-1', KEY_B)).rejects.toBeInstanceOf(
        IdentityPinError,
      );
      // Repeating the substituted key must not wear the pin down.
      await expect(assertPinnedIdentityKey('user-1', KEY_B)).rejects.toBeInstanceOf(
        IdentityPinError,
      );
      const pending = await getPendingIdentityRotation('user-1');
      expect(pending).toEqual({
        pinnedFingerprint: formatIdentityFingerprint(KEY_A),
        pendingFingerprint: formatIdentityFingerprint(KEY_B),
      });
    });

    it('recovers once the user verifies the new key', async () => {
      await assertPinnedIdentityKey('user-1', KEY_A);
      await expect(assertPinnedIdentityKey('user-1', KEY_B)).rejects.toThrow();

      await acceptIdentityRotation('user-1', formatIdentityFingerprint(KEY_B));

      await expect(assertPinnedIdentityKey('user-1', KEY_B)).resolves.toBeTruthy();
      expect(await getPendingIdentityRotation('user-1')).toBeNull();
      // The retired key is no longer accepted.
      await expect(assertPinnedIdentityKey('user-1', KEY_A)).rejects.toBeInstanceOf(
        IdentityPinError,
      );
    });

    it('rejects an empty identity key rather than pinning nothing', async () => {
      await expect(assertPinnedIdentityKey('user-1', '')).rejects.toMatchObject({
        code: 'IDENTITY_KEY_MISSING',
      });
    });

    it('validates a batch atomically enough to block the whole send', async () => {
      await assertPinnedIdentityKey('user-2', KEY_B);
      await expect(
        assertPinnedIdentityKeys([
          { userId: 'user-1', identityKeyHex: KEY_A },
          { userId: 'user-2', identityKeyHex: KEY_C },
        ]),
      ).rejects.toBeInstanceOf(IdentityPinError);
    });

    it('pins a DM peer per channel and blocks a swapped key', async () => {
      await assertPinnedDmPeerIdentity('chan-1', KEY_A);
      expect((await getDmPeerIdentityPin('chan-1'))?.fingerprint).toBe(
        formatIdentityFingerprint(KEY_A),
      );

      await expect(assertPinnedDmPeerIdentity('chan-1', KEY_B)).rejects.toBeInstanceOf(
        IdentityPinError,
      );
      // Still blocked when the caller also supplies the peer user id.
      await expect(assertPinnedDmPeerIdentity('chan-1', KEY_B, 'user-1')).rejects.toBeInstanceOf(
        IdentityPinError,
      );
    });

    it('promotes a channel pin when the user verifies that key', async () => {
      await assertPinnedDmPeerIdentity('chan-1', KEY_A, 'user-1');
      await expect(assertPinnedDmPeerIdentity('chan-1', KEY_B, 'user-1')).rejects.toThrow();

      await markIdentityVerified('user-1', formatIdentityFingerprint(KEY_B));

      await expect(assertPinnedDmPeerIdentity('chan-1', KEY_B, 'user-1')).resolves.toBeUndefined();
      expect((await getDmPeerIdentityPin('chan-1'))?.fingerprint).toBe(
        formatIdentityFingerprint(KEY_B),
      );
    });

    it('does not let one channel pin authorize another', async () => {
      await assertPinnedDmPeerIdentity('chan-1', KEY_A);
      await expect(assertPinnedDmPeerIdentity('chan-2', KEY_B)).resolves.toBeUndefined();
      await expect(assertPinnedDmPeerIdentity('chan-1', KEY_B)).rejects.toBeInstanceOf(
        IdentityPinError,
      );
    });
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

describe('keyVerification durability', () => {
  beforeEach(() => { resetIdentityTrust(); localStorage.clear(); });

  it('keeps a verification decision and a peer pin across a reload', async () => {
    const first = installIdentityTrustVault();
    await markIdentityVerified('user-1', formatIdentityFingerprint(KEY_A));
    await assertPinnedDmPeerIdentity('chan-1', KEY_A, 'user-1');
    expect(await isIdentityVerified('user-1', formatIdentityFingerprint(KEY_A))).toBe(true);

    // A reload: every in-process store is gone; only what the vault holds
    // survives, and the vault is re-opened from the same encrypted records.
    first.lock();
    resetIdentityTrust();
    installIdentityTrustVault(first.records);

    expect(await isIdentityVerified('user-1', formatIdentityFingerprint(KEY_A))).toBe(true);
    expect(await getIdentityTrustState('user-1', formatIdentityFingerprint(KEY_A))).toBe('verified');
    expect((await getDmPeerIdentityPin('chan-1'))?.fingerprint).toBe(formatIdentityFingerprint(KEY_A));
    // Nothing about the decision is written outside the encrypted vault.
    expect(JSON.stringify(localStorage)).not.toContain(KEY_A);
  });

  it('reports unknown, not unverified, while the vault is locked', async () => {
    const trust = installIdentityTrustVault();
    await markIdentityVerified('user-1', formatIdentityFingerprint(KEY_A));
    trust.lock();

    expect(await getIdentityTrustState('user-1', formatIdentityFingerprint(KEY_A))).toBe('unknown');
    await expect(isIdentityVerified('user-1', formatIdentityFingerprint(KEY_A)))
      .rejects.toBeInstanceOf(IdentityTrustLockedError);
    await expect(markIdentityVerified('user-1', formatIdentityFingerprint(KEY_B)))
      .rejects.toBeInstanceOf(IdentityTrustLockedError);
    // A locked vault can prove nothing, so the gate stays closed.
    await expect(assertPinnedIdentityKey('user-1', KEY_A)).rejects.toBeInstanceOf(IdentityTrustLockedError);

    installIdentityTrustVault(trust.records);
    expect(await getIdentityTrustState('user-1', formatIdentityFingerprint(KEY_A))).toBe('verified');
  });

  it('shares one record with the ratchet, so verifying a rotated key releases it', async () => {
    const trust = installIdentityTrustVault();
    const { createSignalVaultDependencies } = await import('./crypto/signalVault');
    const { createIdentityTrustVault } = await import('../test/identityTrustVaultMock');
    // The ratchet reaches the same records through its own transaction.
    const ratchetSees = (identity: string) =>
      createIdentityTrustVault(trust.records).vault.transact(tx =>
        createSignalVaultDependencies(tx, 'chan-1', {} as never)
          .assertPinnedDmPeerIdentity!('chan-1', identity, 'user-1'));

    await ratchetSees(KEY_A);
    await expect(ratchetSees(KEY_B)).rejects.toBeInstanceOf(IdentityPinError);
    await markIdentityVerified('user-1', formatIdentityFingerprint(KEY_B));
    await expect(ratchetSees(KEY_B)).resolves.toBeUndefined();
  });
});
