import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurrentUser } from './useCurrentUser';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import type { User } from '../types';

vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
const profile = (username: string, flags: number): User => ({ id: '42', username, discriminator: 0, flags, bot: false, system: false, created_at: '' });

beforeEach(() => {
  useAuthStore.setState({ user: profile('home-owner', 1), token: 'local-token' });
  useServerListStore.setState({ activeServerId: null, servers: [
    { id: 'remote', name: 'Remote', url: 'https://remote.test', token: 'remote-token', userId: '42', user: profile('remote-member', 0), connected: true },
  ] });
});

describe('current server identity', () => {
  it('switches profiles without inheriting admin flags when user IDs collide', () => {
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current).toMatchObject({ username: 'home-owner', flags: 1 });
    act(() => useServerListStore.getState().setActive('remote'));
    expect(result.current).toMatchObject({ username: 'remote-member', flags: 0 });
    act(() => useServerListStore.getState().mergeUserProjection('remote', { id: '42', display_name: 'New display' }));
    expect(result.current?.display_name).toBe('New display');
    act(() => useServerListStore.getState().setActive(null));
    expect(result.current).toMatchObject({ username: 'home-owner', flags: 1 });
    expect(result.current?.display_name).toBeUndefined();
  });

  it('shows no account when the selected server is unverified or logged out', async () => {
    act(() => useServerListStore.getState().setActive('missing'));
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current).toBeNull();
    act(() => useServerListStore.getState().setActive('remote'));
    expect(result.current?.username).toBe('remote-member');
    await act(() => useServerListStore.getState().clearSessions());
    expect(result.current).toBeNull();
  });
});
