// The desktop shell's HTTP adapter has to hand back the response headers.
//
// It reported `headers: {}` for every request, because the Rust `native_fetch`
// command returned only a status and a body. The API answers every call with
// `X-Paracord-History-Epoch`, and the operation context compares it against the
// epoch the operation captured — absent is not equal, so on the desktop *every*
// response looked like the account's database history had changed underneath
// it. That expired the operation (an error on almost every screen) and asked
// for a history reconciliation, which drops the realtime stream: the desktop
// client could not hold a connection for longer than it took to make one
// request. Headless-Chromium E2E never touches this adapter, so nothing caught
// it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { DATABASE_HISTORY_HEADER } from './databaseHistory';
import { invoke } from '@tauri-apps/api/core';
import { tauriAdapter } from './tauriAxiosAdapter';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./tauriEnv', () => ({ isTauri: vi.fn(() => true) }));

const epoch = '7257b8f7-610e-4a8b-a20c-5a94a7b98428';

function request(): InternalAxiosRequestConfig {
  return {
    method: 'get',
    url: '/users/@me',
    baseURL: 'https://server.example/api/v1',
    headers: new AxiosHeaders(),
  } as InternalAxiosRequestConfig;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('the desktop HTTP adapter', () => {
  it('reports the response headers the API contract puts there', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: { id: '42' },
      headers: { 'x-paracord-history-epoch': epoch, 'content-type': 'application/json' },
    } as never);

    const response = await tauriAdapter(request());

    expect(response.status).toBe(200);
    // Read case-insensitively, exactly as the operation context does.
    expect((response.headers as AxiosHeaders).get(DATABASE_HISTORY_HEADER)).toBe(epoch);
  });

  it('still answers when the shell is older than the headers field', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: { id: '42' } } as never);

    const response = await tauriAdapter(request());

    expect(response.status).toBe(200);
    expect((response.headers as AxiosHeaders).get(DATABASE_HISTORY_HEADER)).toBeFalsy();
  });

  it('carries the headers on the error it throws for a failed status', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 409,
      body: { code: 'HISTORY_CHANGED' },
      headers: { 'x-paracord-history-epoch': epoch },
    } as never);

    await expect(tauriAdapter(request())).rejects.toMatchObject({
      response: { status: 409 },
    });
    await expect(
      tauriAdapter(request()).catch((error: { response: { headers: unknown } }) =>
        AxiosHeaders.from(error.response.headers as never).get(DATABASE_HISTORY_HEADER),
      ),
    ).resolves.toBe(epoch);
  });
});
