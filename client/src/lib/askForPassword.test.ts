// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Ask for my password when Paracord opens" is a choice of this computer
 * (owner decision at M1): stored on the device, never written to the account,
 * and an account's old `crypto_auth_enabled` is adopted once by a device that
 * has not chosen.
 */

const device = vi.hoisted(() => ({
  tauri: true,
  keychain: new Map<string, string>(),
  keystore: { homeOrigin: 'https://home.test', userId: '42', publicKey: 'ab'.repeat(32) } as Record<string, unknown> | null,
}));

vi.mock('./tauriEnv', () => ({ isTauri: () => device.tauri }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: { key: string; value?: string }) => {
    if (command === 'secure_store_set') device.keychain.set(args.key, args.value!);
    else if (command === 'secure_store_delete') device.keychain.delete(args.key);
    else if (command === 'secure_store_get') return device.keychain.get(args.key) ?? null;
    return null;
  }),
}));
vi.mock('./credential/keystoreV2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credential/keystoreV2')>()),
  readKeystoreV2: async () => device.keystore,
}));
vi.mock('./accountSession', () => ({
  withUnlockedPrivateKey: async (fn: (key: Uint8Array) => Promise<void>) => fn(new Uint8Array(32).fill(7)),
}));

const { ASK_FOR_PASSWORD_KEY, adoptAccountChoice, deviceAskChoice, setDeviceAskChoice, useAskForPasswordStore } = await import('./askForPassword');
const { rememberedIdentityKey } = await import('./rememberedUnlock');
const { useAuthStore } = await import('../stores/authStore');
const { useAccountStore } = await import('../stores/accountStore');
const flows = await import('./oneCredential');

const ENTRY = rememberedIdentityKey('https://home.test', '42');
const updateSettings = vi.fn(async () => undefined);

beforeEach(() => {
  localStorage.clear();
  useAskForPasswordStore.setState({ choice: null });
  device.tauri = true;
  device.keychain.clear();
  device.keychain.set(ENTRY, '07'.repeat(32));
  updateSettings.mockClear();
  useAuthStore.setState({
    settings: { crypto_auth_enabled: false } as never,
    hasFetchedSettings: true,
    updateSettings: updateSettings as never,
  });
  useAccountStore.setState({ isUnlocked: true });
});

describe('ask for my password, per device', () => {
  it('keeps the choice on this computer and never writes the account', async () => {
    await flows.applyAskForPassword(true);
    expect(localStorage.getItem(ASK_FOR_PASSWORD_KEY)).toBe('true');
    expect(device.keychain.has(ENTRY)).toBe(false);
    expect(useAskForPasswordStore.getState().choice).toBe(true);

    await flows.applyAskForPassword(false);
    expect(localStorage.getItem(ASK_FOR_PASSWORD_KEY)).toBe('false');
    expect(device.keychain.get(ENTRY)).toBe('07'.repeat(32));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('adopts the account’s old value once, then ignores the account', async () => {
    await flows.adoptAccountAskForPassword(true);
    expect(deviceAskChoice()).toBe(true);
    expect(device.keychain.has(ENTRY)).toBe(false);

    // This computer turns it off; another computer's (account) value stays on.
    await flows.applyAskForPassword(false);
    await flows.adoptAccountAskForPassword(true);
    expect(deviceAskChoice()).toBe(false);
    expect(device.keychain.has(ENTRY)).toBe(true);
  });

  it('adopts "don’t ask" from an account that never asked, and remembers the key', async () => {
    await flows.adoptAccountAskForPassword(false);
    expect(localStorage.getItem(ASK_FOR_PASSWORD_KEY)).toBe('false');
    expect(device.keychain.has(ENTRY)).toBe(true);
  });

  it('the remember policy reads the device first, the account only when the device never chose', async () => {
    useAuthStore.setState({ settings: { crypto_auth_enabled: true } as never });
    await flows.applyRememberPolicy(device.keystore as never);
    expect(deviceAskChoice()).toBe(true);
    expect(device.keychain.has(ENTRY)).toBe(false);

    setDeviceAskChoice(false);
    await flows.applyRememberPolicy(device.keystore as never);
    expect(device.keychain.get(ENTRY)).toBe('07'.repeat(32));
  });

  it('asks when neither this device nor the account can answer, and saves nothing', () => {
    expect(adoptAccountChoice(undefined)).toBe(true);
    expect(localStorage.getItem(ASK_FOR_PASSWORD_KEY)).toBeNull();
  });

  it('fails closed when this device’s storage cannot be read', () => {
    // Replace the whole object: where Storage's methods live differs between
    // Node versions (jsdom's prototype or Node's own), so a spy on one misses
    // the other.
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const refusing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => refusing });
    try {
      expect(deviceAskChoice()).toBe('unreadable');
      expect(adoptAccountChoice(false)).toBe(true);
    } finally {
      if (real) Object.defineProperty(window, 'localStorage', real);
      else delete (window as { localStorage?: Storage }).localStorage;
    }
  });

  it('does nothing in a browser, which always asks', async () => {
    device.tauri = false;
    await flows.applyAskForPassword(false);
    expect(localStorage.getItem(ASK_FOR_PASSWORD_KEY)).toBeNull();
  });
});
