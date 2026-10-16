// @vitest-environment jsdom
import { getPublicKeyAsync, utils } from '@noble/ed25519';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A relaunch came up locked although "remembered unlock" was on.
 *
 * The first secret request of a session starts the keychain agent (KDE's
 * `ksecretd` is D-Bus-activated; gnome-keyring may wait on its password
 * prompt), which takes longer than the shell's 5-second budget. The shell
 * used to record that as "no keychain" for the whole run, and this side
 * treated it the same way: the identity was never written, and a launch that
 * asked a starting keychain read "nothing remembered". A keychain that has not
 * answered yet is waited for, then asked again.
 */

const NOT_ANSWERED = 'secure store unavailable: the OS keychain has not answered yet';

const shell = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  /** Calls of each command that answer "not answered" before the keychain is up. */
  starting: 0,
  ready: true,
  calls: [] as string[],
}));

vi.mock('./tauriEnv', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: { key?: string; value?: string; timeoutMs?: number }) => {
    shell.calls.push(command);
    if (command === 'secure_store_ready') {
      shell.starting = 0;
      return shell.ready;
    }
    if (command.startsWith('secure_store_') && shell.starting > 0) {
      shell.starting -= 1;
      throw NOT_ANSWERED;
    }
    if (command === 'secure_store_set') shell.entries.set(args.key!, args.value!);
    else if (command === 'secure_store_get') return shell.entries.get(args.key!) ?? null;
    else if (command === 'secure_store_delete') shell.entries.delete(args.key!);
    return null;
  }),
}));

const unlockedKey = vi.hoisted(() => ({ value: new Uint8Array(32) as Uint8Array }));
const keystore = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('./credential/keystoreV2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credential/keystoreV2')>()),
  readKeystoreV2: async () => keystore.value,
}));
vi.mock('./accountSession', () => ({
  withUnlockedPrivateKey: async (fn: (key: Uint8Array) => Promise<void>) => fn(unlockedKey.value),
}));

const { KeychainUnavailableError, recallIdentity, rememberedIdentityKey, rememberIdentity } = await import('./rememberedUnlock');
const { setDeviceAskChoice } = await import('./askForPassword');
const { useAuthStore } = await import('../stores/authStore');
const { useAccountStore } = await import('../stores/accountStore');
const flows = await import('./oneCredential');

const ORIGIN = 'https://127.0.0.1:8443';
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

beforeEach(() => {
  localStorage.clear();
  shell.entries.clear();
  shell.starting = 0;
  shell.ready = true;
  shell.calls = [];
  setDeviceAskChoice(false);
  useAuthStore.setState({ settings: { crypto_auth_enabled: false } as never, hasFetchedSettings: true });
  useAccountStore.setState({ isUnlocked: true, rememberProblem: null });
});

describe('a keychain that is still starting', () => {
  it('is waited for at launch, so a remembered identity still opens the app', async () => {
    const privateKey = utils.randomSecretKey();
    const publicKey = hex(await getPublicKeyAsync(privateKey));
    shell.entries.set(rememberedIdentityKey(ORIGIN, '42'), hex(privateKey));
    shell.starting = 1;

    expect(await recallIdentity(ORIGIN, '42', publicKey)).toEqual(privateKey);
    expect(shell.calls).toEqual(['secure_store_get', 'secure_store_ready', 'secure_store_get']);
  });

  it('still answers "nothing remembered" when the keychain never comes up', async () => {
    shell.entries.set(rememberedIdentityKey(ORIGIN, '42'), '07'.repeat(32));
    shell.starting = 1;
    shell.ready = false;
    expect(await recallIdentity(ORIGIN, '42', 'ab'.repeat(32))).toBeNull();
  });

  it('is reported as pending, not as a missing keychain', async () => {
    shell.starting = 1;
    const refusal = await rememberIdentity(ORIGIN, '42', utils.randomSecretKey()).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(KeychainUnavailableError);
    expect((refusal as InstanceType<typeof KeychainUnavailableError>).pending).toBe(true);
  });

  it('remembers the identity once the keychain answers', async () => {
    unlockedKey.value = utils.randomSecretKey();
    const publicKey = hex(await getPublicKeyAsync(unlockedKey.value));
    keystore.value = { version: 2, homeOrigin: ORIGIN, userId: '42', username: 'sean', publicKey };
    shell.starting = 1;

    await flows.applyRememberPolicy(keystore.value as never);
    await vi.waitFor(() => expect(shell.entries.get(rememberedIdentityKey(ORIGIN, '42'))).toBe(hex(unlockedKey.value)));
    expect(useAccountStore.getState().rememberProblem).toBeNull();
    // And the next launch opens without the password.
    expect(await recallIdentity(ORIGIN, '42', publicKey)).toEqual(unlockedKey.value);
  });

  it('does not remember after the person asked for the password meanwhile', async () => {
    unlockedKey.value = utils.randomSecretKey();
    keystore.value = { version: 2, homeOrigin: ORIGIN, userId: '42', username: 'sean', publicKey: hex(await getPublicKeyAsync(unlockedKey.value)) };
    shell.starting = 1;
    await flows.applyRememberPolicy(keystore.value as never);
    setDeviceAskChoice(true);
    await vi.waitFor(() => expect(shell.calls).toContain('secure_store_ready'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shell.entries.size).toBe(0);
  });
});
