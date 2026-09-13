import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { readStoredValueForMigration, secureDelete, secureGet, secureSet } from './secureStorage';

vi.mock('./tauriEnv', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const values = new Map<string, string>();
const calls: string[] = [];
let release: (() => void) | undefined;
let delayedCommand = '';

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  values.clear();
  calls.length = 0;
  release = undefined;
  delayedCommand = '';
  vi.mocked(invoke).mockImplementation(async (command, raw) => {
    const { key, value } = raw as { key: string; value?: string };
    calls.push(`${command}:${key}`);
    if (command === delayedCommand && key === 'session') {
      delayedCommand = '';
      await new Promise<void>(resolve => { release = resolve; });
    }
    if (command === 'secure_store_set') values.set(key, value!);
    if (command === 'secure_store_delete') values.delete(key);
    return (command === 'secure_store_get' ? values.get(key) ?? null : undefined) as never;
  });
});

describe('ordered secure credential operations', () => {
  it('finishes a pending write before deleting credentials on logout', async () => {
    delayedCommand = 'secure_store_set';
    const save = secureSet('session', 'old-token');
    const logout = secureDelete('session');
    const read = secureGet('session');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(calls).toEqual(['secure_store_set:session']);
    release!();
    await Promise.all([save, logout]);
    expect(await read).toBeNull();
    expect(values.has('session')).toBe(false);
  });

  it('does not let a pending logout delete the next login credential', async () => {
    values.set('session', 'old-token');
    delayedCommand = 'secure_store_delete';
    const logout = secureDelete('session');
    const login = secureSet('session', 'new-token');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(calls).toEqual(['secure_store_delete:session']);
    release!();
    await Promise.all([logout, login]);
    expect(await secureGet('session')).toBe('new-token');
  });

  it('clears memory credentials too when native storage previously degraded', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValue(new Error('keychain unavailable'));
    try {
      await secureSet('degraded-session', 'secret');
      expect(await secureGet('degraded-session')).toBe('secret');
      await secureDelete('degraded-session');
      expect(await secureGet('degraded-session')).toBeNull();
    } finally {
      warning.mockRestore();
    }
  });

  it('keeps different keys independent while a native operation is delayed', async () => {
    delayedCommand = 'secure_store_set';
    const delayed = secureSet('session', 'token');
    await secureSet('other-account', 'other-token');
    expect(await secureGet('other-account')).toBe('other-token');
    release!();
    await delayed;
  });
});

describe('strict private-key migration reads', () => {
  it('does not turn a locked keychain into missing keys or use stale local data', async () => {
    const key = 'paracord:migration-locked';
    localStorage.setItem(key, 'older-local-copy');
    vi.mocked(invoke).mockRejectedValue(new Error('Keychain locked'));
    await expect(readStoredValueForMigration(key)).rejects.toThrow('Keychain locked');
    expect(localStorage.getItem(key)).toBe('older-local-copy');
    localStorage.removeItem(key);
  });
  it('reads historical plaintext without mutating or claiming its ownership', async () => {
    const key = 'signal:migration-legacy';
    localStorage.setItem(key, 'historical-private-material');
    expect(await readStoredValueForMigration(key)).toBe('historical-private-material');
    expect(localStorage.getItem(key)).toBe('historical-private-material');
    expect(invoke).not.toHaveBeenCalled();
    localStorage.removeItem(key);
  });
  it('preserves an undecryptable native envelope and reports the recovery failure', async () => {
    const key = 'paracord:migration-corrupt';
    localStorage.setItem(key, 'pcenc:v1:encrypted-data');
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'secure_store_get') return null as never;
      throw new Error('Envelope authentication failed');
    });
    await expect(readStoredValueForMigration(key)).rejects.toThrow('Envelope authentication failed');
    expect(localStorage.getItem(key)).toBe('pcenc:v1:encrypted-data');
    localStorage.removeItem(key);
  });
});
