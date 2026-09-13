import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAvailableChannels, useChannel, useChannelActions, useGuildChannels } from './useChannels';
import { useChannelStore } from '../stores/channelStore';
import { useServerListStore } from '../stores/serverListStore';
import { useAuthStore } from '../stores/authStore';
import { activateChannel } from '../lib/channelNavigation';
import type { Channel, User } from '../types';
vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
const a = { serverId: 'a', userId: '42' };
const b = { serverId: 'b', userId: '42' };
const channel = (name: string): Channel => ({ id: '1', name, guild_id: 'g', type: 0, position: 0, nsfw: false, created_at: '2026-01-01' });
beforeEach(() => {
  useChannelStore.getState().reset();
  useAuthStore.setState({ token: 'home-token', user: { id: '42', username: 'home' } as User });
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, url: `https://${id}.test`, name: id, token: 'token', userId: '42', user: { id: '42', username: id } as User, connected: true })) });
  useChannelStore.getState().addChannel(channel('A'), a);
  useChannelStore.getState().addChannel(channel('B'), b);
});
afterEach(() => { useChannelStore.getState().reset(); });
describe('account-local channel views and navigation', () => {
  it('switches colliding channel and guild IDs without cross-server fallback', () => {
    const { result } = renderHook(() => ({ channel: useChannel('1'), channels: useGuildChannels('g') }));
    expect(result.current.channel?.name).toBe('A');
    act(() => useServerListStore.getState().setActive('b'));
    expect(result.current.channel?.name).toBe('B'); expect(result.current.channels.map(c => c.name)).toEqual(['B']);
    act(() => useServerListStore.getState().setActive('unknown'));
    expect(result.current.channel).toBeUndefined(); expect(result.current.channels).toEqual([]);
  });
  it('retains both colliding IDs in cross-server lists and hides revoked accounts', async () => {
    const { result } = renderHook(() => useAvailableChannels());
    expect(result.current.map(c => c.name)).toEqual(['A', 'B']);
    act(() => useServerListStore.getState().updateToken('a', ''));
    expect(result.current.map(c => c.name)).toEqual(['B']);
    await act(() => useServerListStore.getState().clearSessions());
    expect(result.current).toEqual([]);
  });
  it('keeps action identities stable across cache events and captures their originating account', () => {
    const { result } = renderHook(() => useChannelActions());
    const captured = result.current;
    act(() => useChannelStore.getState().updateChannel({ id: '1', name: 'Updated' }, a));
    expect(result.current).toBe(captured);
    act(() => useServerListStore.getState().setActive('b'));
    expect(result.current).not.toBe(captured);
    act(() => captured.selectChannel('1'));
    expect(useChannelStore.getState().selectedChannel).toEqual({ id: '1', scope: a });
  });
  it('activates exactly the account represented by a clicked channel', () => {
    activateChannel({ id: '1', scope: b });
    expect(useServerListStore.getState().activeServerId).toBe('b');
    expect(useChannelStore.getState().selectedChannel).toEqual({ id: '1', scope: b });
    activateChannel({ id: 'home-dm', scope: { serverId: '__local__', userId: '42' } });
    expect(useServerListStore.getState().activeServerId).toBeNull();
  });
  it('rejects stale navigation after the server signs into a different account', () => {
    useServerListStore.getState().setAuthenticatedUser('b', { id: 'new-account', username: 'New' } as User);
    expect(() => activateChannel({ id: '1', scope: b })).toThrow('no longer signed in');
    expect(useServerListStore.getState().activeServerId).toBe('a');
  });
});
