// Server identity in the renderer (docs/setup-spec.md §7): the shell's pin
// mismatch is told apart from a network failure, identity changes announced by
// the shell are kept until accepted, and the trust commands' refusals surface
// instead of being swallowed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Handler = (event: { payload: unknown }) => void;
const handlers: Handler[] = [];

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: Handler) => {
    handlers.push(handler);
    return () => {};
  }),
}));
vi.mock('./tauriEnv', () => ({ isTauri: vi.fn(() => true) }));

import {
  acceptChangedIdentity,
  identityChangeFor,
  isPinMismatch,
  listenForIdentityChanges,
  loadIdentityChange,
  pinHostFromUrl,
  probeServerIdentity,
  setTrustSource,
  syncTrustedHosts,
  trustServer,
  trustSettled,
  useIdentityChangeStore,
} from './trustedHosts';

const OLD = 'aa'.repeat(32);
const NEW = 'bb'.repeat(32);

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useIdentityChangeStore.setState({ changes: {} });
});

describe('isPinMismatch', () => {
  it('recognizes the shell refusal however it arrives', () => {
    const text = 'TLS certificate pin mismatch for lan.example';
    expect(isPinMismatch(text)).toBe(true);
    expect(isPinMismatch(new Error(text))).toBe(true);
    expect(isPinMismatch(new AxiosError(text, AxiosError.ERR_NETWORK))).toBe(true);
    expect(isPinMismatch(Object.assign(new Error('connect failed'), { cause: new Error(text) }))).toBe(true);
  });

  it('is not a network failure or a trust refusal', () => {
    expect(isPinMismatch(new AxiosError('connect ECONNREFUSED', AxiosError.ERR_NETWORK))).toBe(false);
    expect(isPinMismatch('Native fetch target is not in the trusted server list')).toBe(false);
    expect(isPinMismatch(null)).toBe(false);
  });
});

describe('identity changes announced by the shell', () => {
  it('listens before the first verification and keeps each change by host', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await syncTrustedHosts(['https://lan.example:8443']);
    expect(listen).toHaveBeenCalledWith('trust://identity-changed', expect.any(Function));
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe('update_trusted_server_hosts');

    for (const handler of handlers) {
      handler({ payload: { host: 'lan.example', pinned_fp: OLD, presented_fp: NEW } });
    }
    expect(identityChangeFor('https://LAN.example:8443')).toEqual({ host: 'lan.example', pinnedFp: OLD, presentedFp: NEW });
    expect(identityChangeFor('https://other.example')).toBeNull();
  });

  it('subscribes once per page', async () => {
    const before = vi.mocked(listen).mock.calls.length;
    await listenForIdentityChanges();
    await listenForIdentityChanges();
    expect(vi.mocked(listen).mock.calls.length).toBe(before);
  });

  it('reads the shell record when the page missed the announcement', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ host: '::1', pinned_fp: OLD, presented_fp: NEW });
    await expect(loadIdentityChange('https://[::1]:8443')).resolves.toEqual({ host: '::1', pinnedFp: OLD, presentedFp: NEW });
    expect(invoke).toHaveBeenCalledWith('pending_identity_change', { host: '::1' });
    expect(pinHostFromUrl('https://[::1]:8443')).toBe('::1');
    // Known now: no second call.
    await loadIdentityChange('https://[::1]:8443');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly the recorded certificate and forgets the change', async () => {
    const change = { host: 'lan.example', pinnedFp: OLD, presentedFp: NEW };
    useIdentityChangeStore.getState().record(change);
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await acceptChangedIdentity(change);
    expect(invoke).toHaveBeenCalledWith('accept_changed_identity', { host: 'lan.example', presentedFp: NEW });
    expect(identityChangeFor('https://lan.example')).toBeNull();
  });

  it('surfaces a refused accept and keeps the change', async () => {
    const change = { host: 'lan.example', pinnedFp: OLD, presentedFp: NEW };
    useIdentityChangeStore.getState().record(change);
    vi.mocked(invoke).mockRejectedValueOnce("This server's identity changed again while you were looking at it.");
    await expect(acceptChangedIdentity(change)).rejects.toThrow('changed again');
    expect(identityChangeFor('https://lan.example')).toEqual(change);
  });
});

describe('first contact (§7.3)', () => {
  it('reads the fingerprint and whether a public authority signed it', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ status: 'ok', service: 'paracord', name: 'Kanto', fingerprint: NEW, ca_verified: false });
    await expect(probeServerIdentity('https://kanto.example')).resolves.toEqual({
      status: 'ok',
      service: 'paracord',
      name: 'Kanto',
      fingerprint: NEW,
      caVerified: false,
    });
    expect(invoke).toHaveBeenCalledWith('probe_server', { serverUrl: 'https://kanto.example' });
  });

  // Bug F1: after a restore the sign-in screen probes this computer's own server
  // before any sync has verified it; the shell trusts it by its certificate on the
  // next sync, so the refusal asks for one and the probe runs again.
  it('re-checks trust once when a saved server was refused before it left the machine', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    setTrustSource(() => ['https://127.0.0.1:8443']);
    try {
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'update_trusted_server_hosts') return undefined;
        if (vi.mocked(invoke).mock.calls.filter(([name]) => name === 'probe_server').length === 1) {
          throw 'Native fetch target is not in the trusted server list';
        }
        return { status: 'ok', service: 'paracord', fingerprint: NEW, ca_verified: false };
      });
      await expect(probeServerIdentity('https://127.0.0.1:8443')).resolves.toMatchObject({ fingerprint: NEW });
      expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
        'probe_server',
        'update_trusted_server_hosts',
        'probe_server',
      ]);
    } finally {
      setTrustSource(null);
      vi.useRealTimers();
    }
  });

  it('does not retry a probe refused for any other reason', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('TLS certificate pin mismatch for 127.0.0.1');
    await expect(probeServerIdentity('https://127.0.0.1:8443')).rejects.toBe('TLS certificate pin mismatch for 127.0.0.1');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('surfaces the refusal when the identity changed while the card was showing', async () => {
    vi.mocked(invoke).mockRejectedValueOnce("This server's identity changed while you were looking at it.");
    await expect(trustServer('https://kanto.example', NEW)).rejects.toThrow('changed while you were looking at it');
    expect(invoke).toHaveBeenCalledWith('trust_server', { url: 'https://kanto.example', fingerprint: NEW });
  });
});

describe('a sync the shell could not run', () => {
  it('is reported, not swallowed, and does not hold requests', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValueOnce('Refusing to verify 101 servers at once (the limit is 100).');
    await expect(syncTrustedHosts(['https://lan.example'])).rejects.toThrow('Refusing to verify');
    expect(error).toHaveBeenCalled();
    await expect(trustSettled()).resolves.toBeUndefined();
    error.mockRestore();
  });
});
