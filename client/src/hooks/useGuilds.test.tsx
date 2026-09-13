import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuild, useAvailableGuilds, useCurrentGuilds, useSelectedGuildId } from './useGuilds';
import { useGuildStore } from '../stores/guildStore';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import type { Guild, User } from '../types';
vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
const a = { serverId: 'a', userId: '42' };
const b = { serverId: 'b', userId: '42' };
beforeEach(() => {
  useGuildStore.getState().reset();
  useAuthStore.setState({ user: null, token: null });
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, name: id, url: `https://${id}.test`, connected: true, token: 'token', userId: '42', user: { id: '42', username: id } as User })) });
  for (const scope of [a, b]) useGuildStore.getState().addGuild({ id: '1', name: `Building ${scope.serverId}`, owner_id: scope.serverId === 'a' ? '42' : 'other' } as Guild, scope);
});
describe('scoped guild view selectors', () => {
  it('immediately switches names and ownership for colliding guild IDs', () => {
    const { result } = renderHook(() => useGuild('1'));
    expect(result.current).toMatchObject({ name: 'Building a', owner_id: '42', scope: a });
    act(() => useServerListStore.getState().setActive('b'));
    expect(result.current).toMatchObject({ name: 'Building b', owner_id: 'other', scope: b });
  });
  it('keeps current-account lists distinct while cross-server views retain both entries', () => {
    const { result } = renderHook(() => ({ current: useCurrentGuilds(), all: useAvailableGuilds() }));
    expect(result.current.current.map(guild => guild.name)).toEqual(['Building a']);
    expect(new Set(result.current.all.map(guild => guild.key)).size).toBe(2);
    act(() => useServerListStore.getState().updateToken('b', ''));
    expect(result.current.all.map(guild => guild.name)).toEqual(['Building a']);
  });
  it('does not reuse a selection from a different account or server', () => {
    useGuildStore.getState().selectGuild({ id: '1', scope: a });
    const { result } = renderHook(() => useSelectedGuildId());
    expect(result.current).toBe('1');
    act(() => useServerListStore.getState().setActive('b'));
    expect(result.current).toBeNull();
    act(() => useGuildStore.getState().selectGuild({ id: '1', scope: b }));
    expect(result.current).toBe('1');
    act(() => useServerListStore.getState().setAuthenticatedUser('b', { id: 'new-account', username: 'new' } as User));
    expect(result.current).toBeNull();
  });
});
