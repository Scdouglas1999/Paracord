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
 * Paracord opens" (Settings › Privacy, a choice of this computer kept by
 * `askForPassword.ts`) turns this off: the entry is deleted and `/unlock`
 * asks at every launch.
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

/**
 * The shell's word for a keychain that is still starting (`commands.rs`
 * `SECURE_STORE_NOT_ANSWERED`): the first secret request of a session can
 * start the agent (KDE's `ksecretd`, gnome-keyring) or wait on its password
 * prompt, which takes longer than the shell's 5-second budget. That is not a
 * missing keychain, and it must not be treated as one.
 */
export const KEYCHAIN_NOT_ANSWERED = 'has not answered yet';

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The keychain is still starting: ask again once it has answered. */
export const keychainNotAnswered = (error: unknown): boolean => describe(error).includes(KEYCHAIN_NOT_ANSWERED);

export class KeychainUnavailableError extends Error {
  /** The keychain had not answered yet; `waitForKeychain` then a retry may still succeed. */
  readonly pending: boolean;

  constructor(detail: string) {
    const pending = detail.includes(KEYCHAIN_NOT_ANSWERED);
    super(pending
      ? "This computer's keychain is still starting. Paracord will remember you once it answers."
      : `This computer's keychain isn't available, so Paracord will ask for your password when it opens. (${detail})`);
    this.name = 'KeychainUnavailableError';
    this.pending = pending;
  }
}

/** How long a launch waits for a keychain that is still starting before it asks for the password. */
export const LAUNCH_KEYCHAIN_WAIT_MS = 45_000;
/** How long a background "remember me" waits: long enough to type a wallet password into its prompt. */
export const REMEMBER_KEYCHAIN_WAIT_MS = 180_000;

/**
 * Wait until the keychain has answered the shell's probe; `true` when it keeps
 * secrets. Resolves `false` when it still has not answered after `timeoutMs`,
 * or does not keep secrets.
 */
export async function waitForKeychain(timeoutMs: number): Promise<boolean> {
  if (!canRememberUnlock()) return false;
  try {
    return (await invoke<boolean>('secure_store_ready', { timeoutMs })) === true;
  } catch {
    return false;
  }
}

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
  } catch (error) {
    // No keychain: nothing can have been remembered there. A keychain that is
    // still starting (the first secret request of a session starts the agent)
    // is waited for: answering "locked" here is how a relaunch came up asking
    // for a password the person had asked Paracord to remember.
    if (!keychainNotAnswered(error) || !(await waitForKeychain(LAUNCH_KEYCHAIN_WAIT_MS))) return null;
    try {
      stored = await invoke<string | null>('secure_store_get', { key });
    } catch {
      return null;
    }
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
