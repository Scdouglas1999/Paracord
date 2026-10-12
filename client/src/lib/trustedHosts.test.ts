// The desktop shell refuses every native request to an origin it has not
// verified, and at a cold start it has verified none until the first trust sync
// finishes. A request sent before then fails without leaving the machine; at
// launch that was the session refresh, and the app came up showing "This server
// is not available". The adapter waits for the first sync instead.

import { describe, expect, it, vi } from 'vitest';
import { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./tauriEnv', () => ({ isTauri: vi.fn(() => true) }));

describe('the first trust sync of a launch', () => {
  it('holds native requests until it has settled', async () => {
    let finishSync!: () => void;
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === 'update_trusted_server_hosts') {
        await new Promise<void>((resolve) => {
          finishSync = resolve;
        });
        return undefined;
      }
      return { status: 200, body: { ok: true }, headers: {} };
    });
    const { syncTrustedHosts, trustSettled } = await import('./trustedHosts');
    const { tauriAdapter } = await import('./tauriAxiosAdapter');

    const sync = syncTrustedHosts(['https://lan.example:8443']);
    const request = tauriAdapter({
      method: 'post',
      url: '/auth/refresh',
      baseURL: 'https://lan.example:8443/api/v1',
      headers: new AxiosHeaders(),
    } as InternalAxiosRequestConfig);

    await vi.waitFor(() => expect(calls).toContain('update_trusted_server_hosts'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(['update_trusted_server_hosts']);

    finishSync();
    await sync;
    await expect(request).resolves.toMatchObject({ status: 200 });
    expect(calls).toEqual(['update_trusted_server_hosts', 'native_fetch']);

    // Later syncs (a server added, the periodic re-probe) do not hold requests:
    // the shell keeps the origins it already trusts while they run.
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === 'update_trusted_server_hosts') return new Promise(() => {});
      return { status: 200, body: {}, headers: {} };
    });
    void syncTrustedHosts(['https://lan.example:8443', 'https://other.example']);
    await expect(trustSettled()).resolves.toBeUndefined();
    await expect(
      tauriAdapter({ method: 'get', url: '/users/@me', baseURL: 'https://lan.example:8443/api/v1', headers: new AxiosHeaders() } as InternalAxiosRequestConfig),
    ).resolves.toMatchObject({ status: 200 });
  });
});
