import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

import { useServerListStore } from '../stores/serverListStore';
import { completeServerSecondFactor, serverSignInError, signInToServer } from './serverSignIn';
import vectors from './credential/vectors.json';
import { setKdfWorkerFactory } from './credential/derive';
import { InlineKdfWorker } from './credential/testWorker';

/** An older server: no one-password routes (404, empty body). */
const older = (url: string, then: (url: string) => { status: number; data: unknown }) =>
  url.endsWith('/auth/credential/params') ? { status: 404, data: '' } : then(url);

const world = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; body: unknown }>,
  reply: (() => ({ status: 200, data: {} })) as (url: string) => { status: number; data: unknown } | 'unreachable',
  adopt: vi.fn(async () => {}),
}));
vi.mock('./connectionManager', () => ({ connectionManager: { adoptServerSession: world.adopt } }));
vi.mock('./tauriAxiosAdapter', () => ({
  getTauriAdapter: () => async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const url = axios.getUri(config);
    world.requests.push({ url, body: JSON.parse(String(config.data)) });
    const reply = world.reply(url);
    if (reply === 'unreachable') throw new AxiosError('refused', AxiosError.ERR_NETWORK, config);
    const response = { data: reply.data, status: reply.status, statusText: '', headers: {}, config } as AxiosResponse;
    if (reply.status >= 400) throw new AxiosError('failed', AxiosError.ERR_BAD_REQUEST, config, null, response);
    return response;
  },
}));

beforeEach(() => {
  world.requests = [];
  world.adopt.mockClear();
  useServerListStore.setState({ servers: [{ id: 's_lan', name: 'Lantern', url: 'https://192.168.1.28:8443/', token: '', connected: false }] });
});

describe('signing in to one saved server', () => {
  it('posts the credentials to that server and adopts the session it gives', async () => {
    world.reply = (url) => older(url, () => ({ status: 200, data: { token: 'fresh', refresh_token: 'fresh-refresh', user: { id: '1' } } }));
    await expect(signInToServer('s_lan', ' owner ', 'pw')).resolves.toEqual({ kind: 'signed-in' });
    expect(world.requests.slice(1)).toEqual([{ url: 'https://192.168.1.28:8443/api/v1/auth/login', body: { identifier: 'owner', password: 'pw' } }]);
    expect(world.adopt).toHaveBeenCalledWith('s_lan', 'fresh', 'fresh-refresh');
  });

  it('hands back the second-factor ticket, then adopts after the code', async () => {
    world.reply = (url) => older(url, (u) =>
      u.endsWith('/auth/login')
        ? { status: 200, data: { token: '', user: { mfa_required: true, mfa_ticket: 't1' } } }
        : { status: 200, data: { token: 'fresh', user: { id: '1' } } });
    await expect(signInToServer('s_lan', 'owner', 'pw')).resolves.toEqual({ kind: 'second-factor', ticket: 't1' });
    expect(world.adopt).not.toHaveBeenCalled();
    await expect(completeServerSecondFactor('s_lan', 't1', ' 123456 ')).resolves.toEqual({ kind: 'signed-in' });
    expect(world.requests[2]).toEqual({ url: 'https://192.168.1.28:8443/api/v1/auth/mfa/login', body: { ticket: 't1', code: '123456' } });
    expect(world.adopt).toHaveBeenCalledWith('s_lan', 'fresh', null);
  });

  it('words a wrong password and an unreachable server differently', async () => {
    world.reply = (url) => older(url, () => ({ status: 401, data: { code: 'UNAUTHORIZED', message: 'unauthorized' } }));
    const wrong = await signInToServer('s_lan', 'owner', 'nope').catch((error: unknown) => error);
    expect(serverSignInError(wrong, 'Lantern')).toBe('That email or username and password did not match.');
    world.reply = () => 'unreachable';
    const away = await signInToServer('s_lan', 'owner', 'pw').catch((error: unknown) => error);
    expect(serverSignInError(away, 'Lantern')).toBe('Could not reach Lantern. It may be restarting, or this computer cannot see it.');
    expect(world.adopt).not.toHaveBeenCalled();
  });

  it('on a one-password server sends the derived auth key, never the password', { timeout: 30_000 }, async () => {
    setKdfWorkerFactory(() => new InlineKdfWorker());
    const v = vectors.derivation[0];
    world.reply = (url) => url.endsWith('/auth/credential/params')
      ? { status: 200, data: { version: 2, kdf: v.kdf, salt: v.salt, epoch: 1 } }
      : { status: 200, data: { token: 'fresh', refresh_token: null, user: { id: '1' } } };
    try {
      await expect(signInToServer('s_lan', 'owner', v.password)).resolves.toEqual({ kind: 'signed-in' });
    } finally {
      setKdfWorkerFactory(null);
    }
    expect(world.requests[1]).toEqual({ url: 'https://192.168.1.28:8443/api/v1/auth/credential/login', body: { identifier: 'owner', auth_key: v.auth_key } });
    expect(JSON.stringify(world.requests)).not.toContain(v.password);
  });
});
