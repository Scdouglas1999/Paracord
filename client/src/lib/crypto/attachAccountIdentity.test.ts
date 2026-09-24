import axios, { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { User } from '../../types';
const fixture = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../../api/activeClient', () => ({ getServerApi: () => fixture.client, getApi: () => fixture.client, getActiveApi: () => fixture.client }));
vi.mock('../secureStorage', () => ({ secureSet: vi.fn(), secureGet: vi.fn(), secureDelete: vi.fn() }));
const tokens = vi.hoisted(() => ({ access: null as string | null, refresh: null as string | null }));
vi.mock('../authToken', () => ({
  setAccessToken: vi.fn(),
  setRefreshToken: vi.fn(),
  getAccessToken: () => tokens.access,
  getRefreshToken: () => tokens.refresh,
}));
import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import { captureScopedOperation } from '../operationContext';
import { clearUnlockedPrivateKey, setUnlockedPrivateKey } from '../accountSession';
import { setAccessToken, setRefreshToken } from '../authToken';
import { bytesToHex } from './util';
import { attachAccountIdentity } from './attachAccountIdentity';
import { coordinateRefresh, HOME_REFRESH_SCOPE, resetRefreshCoordination } from '../authRefreshCoordinator';

const key = new Uint8Array(32).fill(42);
const publicKey = bytesToHex(ed25519.getPublicKey(key));
const user = (id: string, key?: string): User => ({ id, username: id, public_key: key, discriminator: 0, bot: false, system: false, flags: 0, created_at: '' });
const context = () => captureScopedOperation({ serverId: 'a', userId: '42' });
let client: ReturnType<typeof axios.create>;
beforeEach(() => {
  vi.clearAllMocks();
  resetRefreshCoordination();
  tokens.access = null; tokens.refresh = null;
  client = axios.create(); fixture.client = client;
  setUnlockedPrivateKey(key.slice());
  useAuthStore.setState({ token: 'home-token', user: user('home') });
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, name: id.toUpperCase(), url: `https://${id}.test`, token: `${id}-token`, userId: '42', user: user('42'), connected: true })) });
});
afterEach(clearUnlockedPrivateKey);

it('signs for the captured origin and installs its replacement session after selection changes', async () => {
  const requests: Array<{ url?: string; baseURL?: string; body: Record<string, string> }> = [];
  const timestamp = Math.floor(Date.now() / 1000);
  client.defaults.adapter = async config => {
    requests.push({ url: config.url, baseURL: config.baseURL, body: config.data ? JSON.parse(config.data) : {} });
    if (config.url === '/auth/challenge') useServerListStore.getState().setActive('b');
    return { config, status: 200, statusText: 'OK', headers: new AxiosHeaders(), data: config.url === '/auth/challenge'
      ? { nonce: 'nonce', timestamp, server_origin: 'https://a.test' }
      : { token: 'replacement-token', refresh_token: 'replacement-refresh', user: user('42', publicKey) } };
  };
  const operation = context();
  await attachAccountIdentity(operation, 'server password', '123456');
  expect(requests.map(r => r.baseURL)).toEqual(['https://a.test/api/v1', 'https://a.test/api/v1']);
  expect(requests[1].body).toMatchObject({ password: 'server password', mfa_code: '123456', public_key: publicKey, expected_public_key: null });
  expect(ed25519.verify(hexToBytes(requests[1].body.signature), new TextEncoder().encode(`nonce:${timestamp}:https://a.test`), ed25519.getPublicKey(key))).toBe(true);
  expect(useServerListStore.getState().getServer('a')).toMatchObject({ token: 'replacement-token', refreshToken: 'replacement-refresh', user: { public_key: publicKey } });
  expect(useServerListStore.getState().getServer('b')?.token).toBe('b-token');
  expect(useAuthStore.getState().token).toBe('home-token');
  expect(operation.signal.aborted).toBe(true);
});

it('rejects an origin mismatch before sending the server password', async () => {
  const adapter = vi.fn(async config => ({ config, status: 200, statusText: 'OK', headers: {}, data: { nonce: 'nonce', timestamp: Math.floor(Date.now() / 1000), server_origin: 'https://b.test' } }));
  client.defaults.adapter = adapter;
  const operation = context();
  await expect(attachAccountIdentity(operation, 'secret')).rejects.toThrow('different server');
  expect(adapter).toHaveBeenCalledTimes(1);
  expect(adapter.mock.calls[0][0].data).toBeUndefined();
  operation.dispose();
});

it('never overwrites an already-enrolled different identity', async () => {
  useServerListStore.getState().setAuthenticatedUser('a', user('42', 'f'.repeat(64)));
  const adapter = vi.fn(); client.defaults.adapter = adapter;
  const operation = context();
  await expect(attachAccountIdentity(operation, 'secret')).rejects.toThrow('different identity');
  expect(adapter).not.toHaveBeenCalled(); operation.dispose();
});

it('recognizes a verified existing attachment without revoking sessions again', async () => {
  useServerListStore.getState().setAuthenticatedUser('a', user('42', publicKey));
  const adapter = vi.fn(); client.defaults.adapter = adapter;
  const operation = context();
  await expect(attachAccountIdentity(operation, '')).resolves.toMatchObject({ public_key: publicKey });
  expect(adapter).not.toHaveBeenCalled(); operation.dispose();
});

it('cannot adopt an attachment response for a different account', async () => {
  client.defaults.adapter = async config => ({ config, status: 200, statusText: 'OK', headers: {}, data: config.url === '/auth/challenge'
    ? { nonce: 'nonce', timestamp: Math.floor(Date.now() / 1000), server_origin: 'https://a.test' }
    : { token: 'wrong', user: user('different', publicKey) } });
  const operation = context();
  await expect(attachAccountIdentity(operation, 'secret')).rejects.toThrow('intended account');
  expect(useServerListStore.getState().getServer('a')?.token).toBe('a-token'); operation.dispose();
});

it('installs the home access token, refresh token and matching profile together', async () => {
  await coordinateRefresh(HOME_REFRESH_SCOPE, async () => ({ token: 'revoked-bootstrap-token' }));
  client.defaults.adapter = async config => ({ config, status: 200, statusText: 'OK', headers: {}, data: config.url === '/auth/challenge'
    ? { nonce: 'nonce', timestamp: Math.floor(Date.now() / 1000), server_origin: window.location.origin }
    : { token: 'new-home', refresh_token: 'new-refresh', user: user('home', publicKey) } });
  await attachAccountIdentity(captureScopedOperation({ serverId: '__local__', userId: 'home' }), 'secret');
  expect(setAccessToken).toHaveBeenCalledWith('new-home');
  expect(setRefreshToken).toHaveBeenCalledWith('new-refresh');
  const refresh = vi.fn(async () => ({ token: 'current-session-token' }));
  expect((await coordinateRefresh(HOME_REFRESH_SCOPE, refresh)).token).toBe('current-session-token');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(useAuthStore.getState()).toMatchObject({ token: 'new-home', user: { id: 'home', public_key: publicKey } });
});

// On the desktop the home session and the server-list entry for this instance
// are the SAME session under two names. Attaching a key revokes that session
// and issues a new one; the copy left holding the revoked token 401'd within
// milliseconds, refreshed with the spent credential, and its `onAuthFailed`
// tore down the home session mid-enrollment — "Waiting for your instance
// account" on a setup the server had already accepted.
it('hands the replacement session to every entry that held the revoked one', async () => {
  tokens.access = 'home-token'; tokens.refresh = 'home-refresh';
  useAuthStore.setState({ token: 'home-token', user: user('home') });
  useServerListStore.setState({
    activeServerId: 'home-entry',
    servers: [
      { id: 'home-entry', name: 'Home', url: 'https://example.test', token: 'home-token', refreshToken: 'home-refresh', userId: 'home', user: user('home'), connected: true },
      { id: 'other', name: 'Other', url: 'https://other.test', token: 'other-token', refreshToken: 'other-refresh', userId: '99', user: user('99'), connected: true },
    ],
  });
  client.defaults.adapter = async config => ({ config, status: 200, statusText: 'OK', headers: {}, data: config.url === '/auth/challenge'
    ? { nonce: 'nonce', timestamp: Math.floor(Date.now() / 1000), server_origin: window.location.origin }
    : { token: 'new-home', refresh_token: 'new-refresh', user: user('home', publicKey) } });

  await attachAccountIdentity(captureScopedOperation({ serverId: '__local__', userId: 'home' }), 'secret');

  expect(useServerListStore.getState().getServer('home-entry')).toMatchObject({
    token: 'new-home',
    refreshToken: 'new-refresh',
    user: { id: 'home', public_key: publicKey },
  });
  // A genuinely different account's session is none of this operation's business.
  expect(useServerListStore.getState().getServer('other')).toMatchObject({ token: 'other-token', refreshToken: 'other-refresh' });
});
