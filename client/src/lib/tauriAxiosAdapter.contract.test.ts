// The desktop bridge contract, from the renderer's side.
//
// Five release blockers in a row were one bug: the renderer and the Rust
// command disagreed about what crosses `invoke`, and headless-Chromium E2E
// cannot see the desktop shell at all, so every one of them shipped.
//
// `client/src-tauri/bridge-contract.json` is the single description of what
// each IPC payload looks like. This file drives the REAL adapter and asserts it
// emits exactly those payloads; `bridge_contract` in
// `client/src-tauri/src/lib.rs` deserializes exactly those payloads into the
// command argument structs. A change on either side that the other has not
// made fails here.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { invoke } from '@tauri-apps/api/core';
import { tauriAdapter } from './tauriAxiosAdapter';
import contract from '../../src-tauri/bridge-contract.json';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./tauriEnv', () => ({ isTauri: vi.fn(() => true) }));

type ContractCase = { name: string; why: string; command: string; req: Record<string, unknown> };
const cases = contract.cases as ContractCase[];
const contractCase = (name: string): ContractCase => {
  const found = cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`bridge-contract.json has no case named "${name}"`);
  return found;
};
/** The `{ command, req }` the adapter is contracted to emit for `name`. */
const expected = (name: string) => {
  const { command, req } = contractCase(name);
  return { command, req };
};

function config(overrides: Partial<InternalAxiosRequestConfig> = {}): InternalAxiosRequestConfig {
  return {
    method: 'get',
    url: '/users/@me',
    baseURL: 'https://server.example/api/v1',
    headers: new AxiosHeaders(),
    ...overrides,
  } as InternalAxiosRequestConfig;
}

const ok = { status: 200, body: {}, headers: {} };

/** The single `invoke(command, { req })` the adapter made. */
function sent(): { command: string; req: Record<string, unknown> } {
  const call = vi.mocked(invoke).mock.calls[0];
  return { command: call[0] as string, req: (call[1] as { req: Record<string, unknown> }).req };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(ok as never);
});

describe('the IPC payloads the adapter emits match the bridge contract', () => {
  it(contractCase('get-with-params').why, async () => {
    await tauriAdapter(
      config({
        url: '/channels/5/messages/recovery',
        params: { after: '0', through: undefined, limit: 100, known_ids: '' },
        headers: new AxiosHeaders({ Authorization: 'Bearer t' }),
      }),
    );
    expect(sent()).toEqual(expected('get-with-params'));
  });

  it(contractCase('json-post').why, async () => {
    await tauriAdapter(
      config({
        method: 'post',
        url: '/channels/5/messages',
        // axios has already run transformRequest by the time an adapter sees
        // the config, so a JSON body arrives here as a string.
        data: JSON.stringify({ content: 'hello' }),
        headers: new AxiosHeaders({ 'Content-Type': 'application/json' }),
        timeout: 30_000,
      }),
    );
    expect(sent()).toEqual(expected('json-post'));
  });

  it(contractCase('form-urlencoded-post').why, async () => {
    await tauriAdapter(
      config({
        method: 'post',
        url: '/thing',
        data: 'a=1&b=2',
        headers: new AxiosHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      }),
    );
    expect(sent()).toEqual(expected('form-urlencoded-post'));
  });

  it(contractCase('binary-response').why, async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: null,
      headers: { 'content-type': 'image/png' },
      body_base64: 'AAEC',
    } as never);
    const response = await tauriAdapter(
      config({ url: '/attachments/9', responseType: 'arraybuffer' }),
    );
    expect(sent()).toEqual(expected('binary-response'));
    expect(new Uint8Array(response.data as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 2]));
  });

  it(contractCase('multipart-upload').why, async () => {
    const form = new FormData();
    form.append('name', 'party');
    form.append('image', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'party.png', { type: 'image/png' }));
    await tauriAdapter(
      config({
        method: 'post',
        url: '/guilds/7/emojis',
        data: form,
        headers: new AxiosHeaders({ 'Content-Type': 'multipart/form-data' }),
      }),
    );
    expect(sent()).toEqual(expected('multipart-upload'));
  });

  it(contractCase('multipart-opaque-blob').why, async () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'application/octet-stream' }),
      '0123456789abcdef0123456789abcdef.bin',
    );
    await tauriAdapter(
      config({
        method: 'post',
        url: '/channels/5/attachments',
        data: form,
        headers: new AxiosHeaders({ 'Content-Type': 'multipart/form-data' }),
        timeout: 120_000,
      }),
    );
    expect(sent()).toEqual(expected('multipart-opaque-blob'));
  });
});

describe('the adapter hands back what axios promises', () => {
  const headerCase = contract.responses.find((r) => r.name === 'headers-are-returned')!;
  const textCase = contract.responses.find((r) => r.name === 'non-json-body-is-text')!;

  it(headerCase.why, async () => {
    vi.mocked(invoke).mockResolvedValue(headerCase.response as never);
    const response = await tauriAdapter(config());
    expect((response.headers as AxiosHeaders).get('X-Paracord-History-Epoch')).toBe(
      headerCase.response.headers['x-paracord-history-epoch'],
    );
    expect(response.statusText).toBe('OK');
  });

  it(textCase.why, async () => {
    vi.mocked(invoke).mockResolvedValue(textCase.response as never);
    await expect(tauriAdapter(config())).rejects.toMatchObject({
      response: { data: textCase.response.body, status: 502 },
      code: AxiosError.ERR_BAD_RESPONSE,
    });
  });

  it('rejects a failed status with a real AxiosError, not a bare Error', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 403, body: { error: 'no' }, headers: {} } as never);
    const error = await tauriAdapter(config()).catch((e: unknown) => e);
    // Every caller that branches on `axios.isAxiosError` / `error.code` read
    // `undefined` here, so a refused connection and a 403 were the same event.
    expect(error).toBeInstanceOf(AxiosError);
    expect((error as AxiosError).code).toBe(AxiosError.ERR_BAD_REQUEST);
    expect((error as AxiosError).response?.status).toBe(403);
  });

  it('reports a transport failure as ERR_NETWORK, and a deadline as ECONNABORTED', async () => {
    vi.mocked(invoke).mockRejectedValue('Connection refused or unreachable: x');
    await expect(tauriAdapter(config())).rejects.toMatchObject({ code: AxiosError.ERR_NETWORK });

    vi.mocked(invoke).mockRejectedValue('Connection timed out.');
    await expect(tauriAdapter(config())).rejects.toMatchObject({ code: AxiosError.ECONNABORTED });
  });

  it('rejects an aborted request instead of resolving it', async () => {
    // An account-session lease aborts its signal when the unlocked account
    // changes; the browser adapter rejects, and everything that calls
    // `assertCurrent()` afterwards depends on that.
    const controller = new AbortController();
    controller.abort();
    await expect(tauriAdapter(config({ signal: controller.signal }))).rejects.toMatchObject({
      code: AxiosError.ERR_CANCELED,
    });
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    const later = new AbortController();
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}) as never);
    const pending = tauriAdapter(config({ signal: later.signal }));
    later.abort();
    await expect(pending).rejects.toMatchObject({ code: AxiosError.ERR_CANCELED });
  });

  it('keeps a query string already present on the url', async () => {
    await tauriAdapter(config({ url: '/messages?limit=50', params: { before: '9' } }));
    expect(sent().req.url).toBe('https://server.example/api/v1/messages?limit=50&before=9');
  });

  it('still answers when the shell is older than the headers field', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: { id: '42' } } as never);
    const response = await tauriAdapter(config());
    expect(response.status).toBe(200);
    expect((response.headers as AxiosHeaders).get('X-Paracord-History-Epoch')).toBeFalsy();
  });
});

describe('the contract file itself', () => {
  it('names a command that the Rust side registers for every case', () => {
    // The Rust `bridge_contract` tests read the same file; this only guards
    // against a case being added here with a command name that is a typo.
    const known = new Set([
      'native_fetch',
      'native_multipart',
      'native_upload_file',
      'native_download_file',
    ]);
    for (const entry of cases) expect(known).toContain(entry.command);
    expect(cases.length).toBeGreaterThan(0);
  });
});
