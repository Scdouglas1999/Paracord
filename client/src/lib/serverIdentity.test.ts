import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore, type ServerEntry } from '../stores/serverListStore';
import type { User } from '../types';
import { accountScopeServerIds, findHomeServerEntry, getServerUser, mergeServerUserProjection, resolveHomeServerUrl } from './serverIdentity';
import { setStoredServerUrl } from './config/apiBaseUrl';
import { accountScopeKey, entityScopeKey, LOCAL_SERVER_ID } from './serverScope';

vi.mock('./secureStorage', () => ({ secureSet: vi.fn(), secureGet: vi.fn(), secureDelete: vi.fn() }));
const user = (username: string, flags = 0): User => ({
  id: '42', username, flags, email: `${username}@example.test`, discriminator: 0,
  bot: false, system: false, created_at: '2026-09-08T00:00:00Z',
});

beforeEach(() => {
  useAuthStore.setState({ user: user('home', 1), token: 'home-token' });
  useServerListStore.setState({ servers: [
    { id: 'remote', url: 'https://remote.test', name: 'Remote', token: 'remote-token', connected: true },
  ], activeServerId: LOCAL_SERVER_ID });
});

describe('server-bound authenticated profiles', () => {
  it('keeps matching user IDs on two servers separate, including private fields', () => {
    useServerListStore.getState().setAuthenticatedUser('remote', user('remote'));
    mergeServerUserProjection('remote', { id: '42', display_name: 'Remote display' });
    expect(getServerUser('remote')).toMatchObject({ username: 'remote', flags: 0, email: 'remote@example.test', display_name: 'Remote display' });
    expect(getServerUser(LOCAL_SERVER_ID)).toEqual(user('home', 1));
  });

  it('cannot establish an account or inherit a local profile from a public event', () => {
    mergeServerUserProjection('remote', { id: '42', username: 'unverified' });
    expect(getServerUser('remote')).toBeNull();
    expect(getServerUser(LOCAL_SERVER_ID)?.username).toBe('home');
  });

  it('rejects late projections for another account and replaces private fields on login', () => {
    useServerListStore.getState().setAuthenticatedUser('remote', user('owner', 1));
    useServerListStore.getState().setAuthenticatedUser('remote', { ...user('member'), id: '43', email: undefined });
    mergeServerUserProjection('remote', { id: '42', username: 'stale-owner', flags: 1 });
    expect(getServerUser('remote')).toMatchObject({ id: '43', username: 'member', flags: 0 });
    expect(getServerUser('remote')?.email).toBeUndefined();
  });

  it('has no authenticated remote user after its token is revoked', () => {
    useServerListStore.getState().setAuthenticatedUser('remote', user('remote'));
    useServerListStore.getState().updateToken('remote', '');
    expect(getServerUser('remote')).toBeNull();
  });

  it('does not persist private server profiles', () => {
    useServerListStore.getState().setAuthenticatedUser('remote', user('remote'));
    const serialized = localStorage.getItem('paracord:server-list');
    expect(serialized).not.toContain('remote@example.test');
    expect(serialized).not.toContain('remote-token');
  });
});

describe('compound account and entity keys', () => {
  it('separates colliding IDs and delimiter-like scope values', () => {
    const a = { serverId: 'a:b', userId: 'c' };
    const b = { serverId: 'a', userId: 'b:c' };
    expect(accountScopeKey(a)).not.toBe(accountScopeKey(b));
    expect(entityScopeKey(a, '42')).not.toBe(entityScopeKey(b, '42'));
    expect(entityScopeKey(a, '42')).not.toBe(entityScopeKey({ ...a, userId: 'd' }, '42'));
  });
});

/**
 * Which server-list entry IS the home server. Everything that must not count one
 * account twice — the building list, the account scopes, the sweeps over every
 * signed-in account — hangs off this one answer, so it is tested here at the
 * scope-resolution level rather than only through a rendered list.
 *
 * The user types an address; nothing guarantees they type it the way it is
 * stored. `127.0.0.1:18600` with no scheme, `localhost`, a trailing slash and a
 * capitalized host all name the same server, and a spelling difference must
 * never split one account into two.
 */
describe('the home server among the servers in the list', () => {
  const HOME_TOKEN = 'home-session-token';
  const entry = (over: Partial<ServerEntry> = {}): ServerEntry => ({
    id: 's_home', url: 'http://127.0.0.1:18600', name: 'QA', token: HOME_TOKEN, connected: true, ...over,
  });

  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ user: user('owner'), token: HOME_TOKEN });
    useServerListStore.setState({ servers: [], activeServerId: null });
  });

  it.each([
    ['the same spelling', 'http://127.0.0.1:18600', 'http://127.0.0.1:18600'],
    ['localhost against the loopback address', 'http://localhost:18600', 'http://127.0.0.1:18600'],
    ['the loopback address against localhost', 'http://127.0.0.1:18600', 'http://localhost:18600'],
    ['a trailing slash', 'http://127.0.0.1:18600/', 'http://127.0.0.1:18600'],
    ['a capitalized host', 'http://LOCALHOST:18600', 'http://127.0.0.1:18600'],
    ['an /api/v1 suffix on the stored URL', 'http://127.0.0.1:18600/api/v1', 'http://127.0.0.1:18600'],
  ])('finds it through %s', (_why, storedUrl, entryUrl) => {
    setStoredServerUrl(storedUrl);
    useServerListStore.setState({ servers: [entry({ url: entryUrl })], activeServerId: 's_home' });
    expect(findHomeServerEntry()?.id).toBe('s_home');
    expect(accountScopeServerIds(['s_home'])).toEqual(['s_home']);
  });

  it('finds it by session token when the stored URL has not caught up', () => {
    // The connect screen stores the URL after the entry is created, so there is
    // a window where only the shared session token identifies the home server.
    useServerListStore.setState({ servers: [entry({ url: 'http://127.0.0.1:18600' })], activeServerId: 's_home' });
    expect(resolveHomeServerUrl()).not.toContain('18600');
    expect(findHomeServerEntry()?.id).toBe('s_home');
    expect(accountScopeServerIds(['s_home'])).toEqual(['s_home']);
  });

  it('does not fold a different port on the same machine into the home server', () => {
    setStoredServerUrl('http://127.0.0.1:18600');
    useServerListStore.setState({ servers: [entry({ id: 's_other', url: 'http://127.0.0.1:18601', token: 'other-token' })], activeServerId: 's_other' });
    expect(findHomeServerEntry()).toBeUndefined();
    expect(accountScopeServerIds(['s_other'])).toEqual([LOCAL_SERVER_ID, 's_other']);
  });

  it('leaves the home scope in place when nothing in the list is the home server', () => {
    setStoredServerUrl('http://127.0.0.1:18600');
    expect(findHomeServerEntry()).toBeUndefined();
    expect(accountScopeServerIds([])).toEqual([LOCAL_SERVER_ID]);
  });
});
