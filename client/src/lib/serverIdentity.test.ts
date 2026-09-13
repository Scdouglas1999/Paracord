import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import type { User } from '../types';
import { getServerUser, mergeServerUserProjection } from './serverIdentity';
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
