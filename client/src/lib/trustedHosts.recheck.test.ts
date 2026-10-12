// A server that was down when the app started, or when the last check ran, is not
// trusted by the desktop shell until a probe reaches it, and it refuses every request
// to an origin it has not verified before anything leaves the machine. The sign-in
// screen then said "Could not reach" until the 30-second beat looked again, for a
// server that had been back for seconds. A refused request now asks for the check
// itself and is sent again, once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
const env = vi.hoisted(() => ({ tauri: true }));
vi.mock('./tauriEnv', () => ({ isTauri: vi.fn(() => env.tauri) }));

const REFUSAL = 'Native fetch target is not in the trusted server list';
const LAN = 'https://lan.example:8443';

function login(): InternalAxiosRequestConfig {
  return { method: 'post', url: '/auth/login', baseURL: `${LAN}/api/v1`, data: '{}', headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
}

async function modules() {
  vi.resetModules();
  const trusted = await import('./trustedHosts');
  const adapter = await import('./tauriAxiosAdapter');
  trusted.setTrustSource(() => [LAN]);
  return { ...trusted, ...adapter };
}

beforeEach(() => {
  env.tauri = true;
  vi.mocked(invoke).mockReset();
});
afterEach(() => vi.useRealTimers());

describe('a request the shell refuses for want of a trust check', () => {
  it('asks for the check at once and is sent again, once', async () => {
    const calls: Array<[string, unknown]> = [];
    let fetches = 0;
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      calls.push([command, args]);
      if (command === 'native_fetch') {
        fetches += 1;
        if (fetches === 1) throw REFUSAL;
        return { status: 200, body: { token: 't' }, headers: {} };
      }
      return undefined;
    });
    const { tauriAdapter } = await modules();

    await expect(tauriAdapter(login())).resolves.toMatchObject({ status: 200 });
    expect(calls.map(([command]) => command)).toEqual(['native_fetch', 'update_trusted_server_hosts', 'native_fetch']);
    expect(calls[1][1]).toEqual({ serverUrls: [LAN] });
  });

  it('surfaces the refusal when the server is still not there, without looping', async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === 'native_fetch') throw REFUSAL;
      return undefined;
    });
    const { tauriAdapter } = await modules();

    const failure = await tauriAdapter(login()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AxiosError);
    expect((failure as AxiosError).code).toBe(AxiosError.ERR_NETWORK);
    expect((failure as AxiosError).message).toBe(REFUSAL);
    expect(calls).toEqual(['native_fetch', 'update_trusted_server_hosts', 'native_fetch']);
  });

  it('does not probe again on the next click while the last check is fresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === 'native_fetch') throw REFUSAL;
      return undefined;
    });
    const { tauriAdapter, TRUST_RECHECK_COOLDOWN_MS } = await modules();

    await tauriAdapter(login()).catch(() => undefined);
    calls.length = 0;
    vi.setSystemTime(Date.now() + 1_000);
    await expect(tauriAdapter(login())).rejects.toMatchObject({ message: REFUSAL });
    expect(calls).toEqual(['native_fetch']);

    // Past the cooldown it checks again.
    vi.setSystemTime(Date.now() + TRUST_RECHECK_COOLDOWN_MS);
    calls.length = 0;
    await tauriAdapter(login()).catch(() => undefined);
    expect(calls).toEqual(['native_fetch', 'update_trusted_server_hosts', 'native_fetch']);
  });

  it('waits for a check that is already running instead of starting another', async () => {
    let finish!: () => void;
    const calls: string[] = [];
    let fetches = 0;
    let hold = false;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === 'update_trusted_server_hosts') {
        if (hold) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return undefined;
      }
      fetches += 1;
      if (fetches === 1) throw REFUSAL;
      return { status: 200, body: {}, headers: {} };
    });
    const { tauriAdapter, syncTrustedHosts } = await modules();

    // The launch's first sync is over (it would hold requests until it settled)...
    await syncTrustedHosts([LAN]);
    calls.length = 0;
    // ...and a later one (the list changed) is still running when a request is refused.
    hold = true;
    void syncTrustedHosts([LAN]);
    const request = tauriAdapter(login());
    await vi.waitFor(() => expect(calls).toEqual(['update_trusted_server_hosts', 'native_fetch']));
    finish();
    await expect(request).resolves.toMatchObject({ status: 200 });
    // It waited for that check and sent again; it did not start a second one.
    expect(calls).toEqual(['update_trusted_server_hosts', 'native_fetch', 'native_fetch']);
  });

  it('does not wait out a check that is stuck (a dialog nobody has answered) before sending again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const calls: string[] = [];
    let fetches = 0;
    let hold = false;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === 'update_trusted_server_hosts') {
        if (hold) await new Promise<void>(() => {});
        return undefined;
      }
      fetches += 1;
      if (fetches === 1) throw REFUSAL;
      return { status: 200, body: {}, headers: {} };
    });
    const { tauriAdapter, syncTrustedHosts, TRUST_RECHECK_WAIT_MS } = await modules();
    await syncTrustedHosts([LAN]);
    hold = true;
    void syncTrustedHosts([LAN]);

    const request = tauriAdapter(login());
    await vi.advanceTimersByTimeAsync(TRUST_RECHECK_WAIT_MS + 1);
    await expect(request).resolves.toMatchObject({ status: 200 });
  });

  it('is not retried when the failure is not the shell’s trust refusal', async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      calls.push(command);
      throw 'Connection refused or unreachable: error sending request';
    });
    const { tauriAdapter } = await modules();

    await expect(tauriAdapter(login())).rejects.toMatchObject({ code: AxiosError.ERR_NETWORK });
    expect(calls).toEqual(['native_fetch']);
  });

  it('does nothing outside the desktop shell', async () => {
    env.tauri = false;
    const { recheckTrust } = await modules();
    await expect(recheckTrust()).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
