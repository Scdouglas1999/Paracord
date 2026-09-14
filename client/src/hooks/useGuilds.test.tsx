import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuild, useAvailableGuilds, useCurrentGuilds, useSelectedGuildId } from './useGuilds';
import { useAvailableAccountScopes } from './useAvailableAccountScopes';
import { accountScopeServerIds } from '../lib/serverIdentity';
import { setStoredServerUrl } from '../lib/config/apiBaseUrl';
import { LOCAL_SERVER_ID } from '../lib/serverScope';
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

/**
 * A fresh desktop install: the shell has no origin server, so it adds its own
 * server by address and that entry holds the home session. The same building
 * therefore arrived under the entry's scope (from the gateway) AND under
 * `__local__` (from the home session's REST fetch) — the sidebar listed it
 * twice, and Home read "2 people have their lights on across your 2 buildings"
 * for one person and one building.
 */
describe('one server is one account', () => {
  const HOME_URL = 'http://127.0.0.1:18680';
  const HOME_TOKEN = 'home-session-token';
  const owner = { id: '900', username: 'owner' } as User;
  const home = { serverId: 's_home', userId: owner.id };
  const local = { serverId: LOCAL_SERVER_ID, userId: owner.id };
  const building = { id: 'g1', name: 'Test Building', owner_id: owner.id } as Guild;

  beforeEach(() => {
    useGuildStore.getState().reset();
    localStorage.clear();
    setStoredServerUrl(HOME_URL);
    useAuthStore.setState({ user: owner, token: HOME_TOKEN });
    useServerListStore.setState({
      activeServerId: 's_home',
      servers: [{ id: 's_home', name: 'QA', url: HOME_URL, connected: true, token: HOME_TOKEN, userId: owner.id, user: owner }],
    });
  });

  it('lists a building once when the added server is also the home session', () => {
    for (const scope of [home, local]) useGuildStore.getState().addGuild(building, scope);
    const { result } = renderHook(() => useAvailableGuilds());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.scope.serverId).toBe('s_home');
  });

  it('offers one account scope, and sweeps that account once', () => {
    const { result } = renderHook(() => useAvailableAccountScopes());
    expect(result.current.map(scope => scope.serverId)).toEqual(['s_home']);
    expect(accountScopeServerIds(['s_home'])).toEqual(['s_home']);
  });

  it('still uses the home scope when no entry stands for the home server', () => {
    // A browser served by its own instance, or a profile recovered from a
    // phrase, which never gets an entry token: `__local__` is all there is.
    useServerListStore.setState({ activeServerId: null, servers: [] });
    useGuildStore.getState().addGuild(building, local);
    const { result } = renderHook(() => useAvailableGuilds());
    expect(result.current.map(guild => guild.scope.serverId)).toEqual([LOCAL_SERVER_ID]);
    expect(accountScopeServerIds([])).toEqual([LOCAL_SERVER_ID]);
  });

  it('keeps a genuinely different server as its own account', () => {
    useServerListStore.setState(state => ({
      servers: [...state.servers, { id: 's_remote', name: 'Remote', url: 'https://remote.test', connected: true, token: 'remote-token', userId: '901', user: { id: '901', username: 'remote' } as User }],
    }));
    useGuildStore.getState().addGuild(building, home);
    useGuildStore.getState().addGuild({ ...building, id: 'g2' }, { serverId: 's_remote', userId: '901' });
    const { result } = renderHook(() => useAvailableGuilds());
    expect(result.current.map(guild => guild.scope.serverId).sort()).toEqual(['s_home', 's_remote']);
    expect(accountScopeServerIds(['s_home', 's_remote'])).toEqual(['s_home', 's_remote']);
  });
});
