import { invoke } from '@tauri-apps/api/core';
import { getPublicKeyAsync } from '@noble/ed25519';
import { isTauri } from './tauriEnv';
import { bytesToHex } from './crypto/util';

/**
 * Desktop remembered unlock (docs/setup-spec.md §3.5).
 *
 * After a successful unlock the desktop app keeps the identity private key in
 * the OS keychain under `paracord:identity:<homeOrigin>:<userId>`, so a
 * relaunch opens without asking for the password. "Ask for my password when
 * Paracord opens" (Settings › Privacy, `crypto_auth_enabled`) turns this off:
 * the entry is deleted and `/unlock` asks at every launch.
 *
 * One path only: the OS keychain through `secure_store_*`. This module never
 * uses the generic secure store's encrypted-file or in-memory fallbacks. When
 * the keychain cannot be used, the key is not remembered and the caller is
 * told why. The web never persists the key.
 */

export const REMEMBERED_IDENTITY_PREFIX = 'paracord:identity:';

/** The keychain entry for an account. */
export function rememberedIdentityKey(homeOrigin: string, userId: string): string {
  return `${REMEMBERED_IDENTITY_PREFIX}${homeOrigin}:${userId}`;
}

/** Remembered unlock is a desktop feature; a browser tab always asks. */
export const canRememberUnlock = (): boolean => isTauri();

export class KeychainUnavailableError extends Error {
  constructor(detail: string) {
    super(`This computer's keychain isn't available, so Paracord will ask for your password when it opens. (${detail})`);
    this.name = 'KeychainUnavailableError';
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Store the identity for the next launch. Throws `KeychainUnavailableError` when the keychain refuses. */
export async function rememberIdentity(homeOrigin: string, userId: string, privateKey: Uint8Array): Promise<void> {
  if (!canRememberUnlock()) return;
  if (privateKey.length !== 32) throw new Error('Account identity keys must contain 32 bytes.');
  try {
    await invoke('secure_store_set', { key: rememberedIdentityKey(homeOrigin, userId), value: bytesToHex(privateKey) });
  } catch (error) {
    throw new KeychainUnavailableError(describe(error));
  }
}

/**
 * The remembered identity, checked against the public key it must belong to.
 * `null` when nothing is remembered. An entry that does not match (another
 * identity, corrupted) is deleted and treated as absent: the person types the
 * password instead, and nothing weaker is used.
 */
export async function recallIdentity(homeOrigin: string, userId: string, publicKey: string): Promise<Uint8Array | null> {
  if (!canRememberUnlock()) return null;
  const key = rememberedIdentityKey(homeOrigin, userId);
  let stored: string | null;
  try {
    stored = await invoke<string | null>('secure_store_get', { key });
  } catch {
    // No keychain: nothing can have been remembered there.
    return null;
  }
  if (!stored) return null;
  if (!/^[0-9a-f]{64}$/.test(stored)) {
    await forgetIdentity(homeOrigin, userId);
    return null;
  }
  const privateKey = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) privateKey[i] = Number.parseInt(stored.slice(i * 2, i * 2 + 2), 16);
  if (bytesToHex(await getPublicKeyAsync(privateKey)) !== publicKey.toLowerCase()) {
    privateKey.fill(0);
    await forgetIdentity(homeOrigin, userId);
    return null;
  }
  return privateKey;
}

/** Delete the remembered identity (sign-out, "Ask for my password" on). */
export async function forgetIdentity(homeOrigin: string, userId: string): Promise<void> {
  if (!canRememberUnlock()) return;
  try {
    await invoke('secure_store_delete', { key: rememberedIdentityKey(homeOrigin, userId) });
  } catch {
    // No keychain: nothing to delete.
  }
}
