import { getPublicKeyAsync, utils } from '@noble/ed25519';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.hoisted(() => ({ entries: new Map<string, string>(), broken: false, tauri: true }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: { key: string; value?: string }) => {
    if (keychain.broken) throw new Error('no secret service');
    if (command === 'secure_store_set') keychain.entries.set(args.key, args.value!);
    else if (command === 'secure_store_get') return keychain.entries.get(args.key) ?? null;
    else if (command === 'secure_store_delete') keychain.entries.delete(args.key);
    return null;
  }),
}));
vi.mock('./tauriEnv', () => ({ isTauri: () => keychain.tauri }));

const { forgetIdentity, KeychainUnavailableError, recallIdentity, rememberedIdentityKey, rememberIdentity } = await import('./rememberedUnlock');

const ORIGIN = 'https://home.test';
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

beforeEach(() => {
  keychain.entries.clear();
  keychain.broken = false;
  keychain.tauri = true;
});

describe('remembered unlock', () => {
  it('stores the key under paracord:identity:<origin>:<user> and recalls it only for its own public key', async () => {
    const privateKey = utils.randomSecretKey();
    const publicKey = hex(await getPublicKeyAsync(privateKey));
    await rememberIdentity(ORIGIN, '42', privateKey);
    expect([...keychain.entries.keys()]).toEqual([rememberedIdentityKey(ORIGIN, '42')]);
    expect(rememberedIdentityKey(ORIGIN, '42')).toBe('paracord:identity:https://home.test:42');

    expect(await recallIdentity(ORIGIN, '42', publicKey)).toEqual(privateKey);
    // Another identity's entry is never used, and is deleted.
    expect(await recallIdentity(ORIGIN, '42', 'ab'.repeat(32))).toBeNull();
    expect(keychain.entries.size).toBe(0);
  });

  it('forgets on request', async () => {
    await rememberIdentity(ORIGIN, '42', utils.randomSecretKey());
    await forgetIdentity(ORIGIN, '42');
    expect(keychain.entries.size).toBe(0);
  });

  it('says so when the keychain is unavailable, with no fallback store', async () => {
    keychain.broken = true;
    await expect(rememberIdentity(ORIGIN, '42', utils.randomSecretKey())).rejects.toBeInstanceOf(KeychainUnavailableError);
    expect(await recallIdentity(ORIGIN, '42', 'ab'.repeat(32))).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('does nothing in a browser', async () => {
    keychain.tauri = false;
    await rememberIdentity(ORIGIN, '42', utils.randomSecretKey());
    expect(keychain.entries.size).toBe(0);
  });
});
