import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDmCipher, type DmCipherDependencies } from './dmCipher';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from './crypto/util';

function fixture() {
  const dependencies: DmCipherDependencies = {
    loadSession: vi.fn(async () => null), saveSession: vi.fn(async () => {}),
    loadPrekeyStore: vi.fn(async () => null), savePrekeyStore: vi.fn(async () => {}),
    assertPinnedDmPeerIdentity: vi.fn(async () => {}),
    keysApi: { getBundle: vi.fn(async () => { throw new Error('Peer not enrolled'); }) },
  };
  const key = new Uint8Array(32).fill(31);
  const peer = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(32)));
  return { dependencies, cipher: createDmCipher(dependencies), key, peer };
}
afterEach(() => vi.unstubAllEnvs());

describe('Signal protocol failure boundaries', () => {
  it('never downgrades a missing session or peer bundle even with the former environment flag set', async () => {
    vi.stubEnv('VITE_DM_E2EE_ALLOW_V1_FALLBACK', 'true');
    const { cipher, dependencies, key, peer } = fixture();
    await expect(cipher.encryptDmMessage('channel', 'Private', key, peer)).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    await expect(cipher.encryptDmMessageV2('channel', 'Private', key, peer, 'peer')).rejects.toMatchObject({ code: 'PEER_BUNDLE_UNAVAILABLE' });
    expect(dependencies.saveSession).not.toHaveBeenCalled();
  });

  it('rejects a v2 envelope without its header rather than interpreting it as v1', async () => {
    const { cipher, dependencies, key, peer } = fixture();
    await expect(cipher.decryptDmMessage('channel', { version: 2, nonce: 'nonce', ciphertext: 'ciphertext' }, key, peer, 'peer')).rejects.toThrow(/require.*header/);
    expect(dependencies.loadSession).not.toHaveBeenCalled();
    expect(dependencies.saveSession).not.toHaveBeenCalled();
  });

  it('checks the pinned identity before accessing an existing session', async () => {
    const { cipher, dependencies, key, peer } = fixture();
    vi.mocked(dependencies.assertPinnedDmPeerIdentity).mockRejectedValue(new Error('Identity changed'));
    await expect(cipher.encryptDmMessageV2('channel', 'Private', key, peer, 'peer')).rejects.toThrow('Identity changed');
    expect(dependencies.loadSession).not.toHaveBeenCalled();
    expect(dependencies.keysApi.getBundle).not.toHaveBeenCalled();
  });
});


it('rejects malformed peer keys before pinning or loading a session', async () => {
  const { cipher, dependencies, key, peer } = fixture();
  await expect(cipher.encryptDmMessageV2('channel', 'Private', key, `${peer}z`, 'peer')).rejects.toMatchObject({ code: 'PEER_IDENTITY_MISMATCH' });
  expect(dependencies.assertPinnedDmPeerIdentity).not.toHaveBeenCalled();
  expect(dependencies.loadSession).not.toHaveBeenCalled();
});
