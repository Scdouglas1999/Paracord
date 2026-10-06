import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_SERVER_ID, entityScopeKey, type AccountScope } from '../../../lib/serverScope';
import { useServerListStore } from '../../../stores/serverListStore';
import { PEOPLE_PLACE, serverPlace } from './place';
import { placeKeysFor, resolvePlaceKeys, usePlaceKeys } from './placeKeys';

/**
 * A place's key is its server's id, kept unique per saved server: two instances can mint the same
 * snowflake (every instance's generator starts a fresh process at sequence zero with the same
 * worker number, so two fresh servers that each make their first server in the same millisecond
 * agree), and the dock showed both under one id.
 */

const mocks = vi.hoisted(() => ({ guilds: [] as unknown[] }));
vi.mock('../../../hooks/useGuilds', () => ({ useAvailableGuilds: () => mocks.guilds }));

const HOME: AccountScope = { serverId: LOCAL_SERVER_ID, userId: 'me' };
const LANTERN: AccountScope = { serverId: 's_lantern', userId: 'me-on-lantern' };
const CEDAR: AccountScope = { serverId: 's_cedar', userId: 'me-on-cedar' };

const guild = (id: string, name: string, scope: AccountScope) => ({ id, name, scope, key: entityScopeKey(scope, id) });
const ORDER = [LOCAL_SERVER_ID, 's_cedar', 's_lantern'];

describe('placeKeysFor', () => {
  it('keeps every id as it is when no two servers share one', () => {
    const guilds = [guild('100', 'Fuel', HOME), guild('200', 'Cedar place', CEDAR), guild('300', 'Lantern place', LANTERN)];
    const keys = placeKeysFor(guilds, ORDER);
    expect(guilds.map((entry) => keys.get(entityScopeKey(entry.scope, entry.id)))).toEqual(['100', '200', '300']);
  });

  it('keeps apart two servers that minted the same id: the first saved server keeps the id', () => {
    // Lantern is listed first in the store (it connected first), Cedar was saved before it.
    const guilds = [guild('777', 'Lantern place', LANTERN), guild('777', 'Cedar place', CEDAR), guild('100', 'Fuel', HOME)];
    const keys = placeKeysFor(guilds, ORDER);
    expect(keys.get(entityScopeKey(CEDAR, '777'))).toBe('777');
    expect(keys.get(entityScopeKey(LANTERN, '777'))).toBe('777@s_lantern');
    expect(keys.get(entityScopeKey(HOME, '100'))).toBe('100');
    // Unique across everything given.
    expect(new Set(keys.values()).size).toBe(3);
  });

  it('puts the home server ahead of the saved ones, and a server it cannot place last', () => {
    const stranger: AccountScope = { serverId: 's_unknown', userId: 'x' };
    const guilds = [guild('9', 'Stranger', stranger), guild('9', 'Lantern', LANTERN), guild('9', 'Home', HOME)];
    const keys = placeKeysFor(guilds, ORDER);
    expect(keys.get(entityScopeKey(HOME, '9'))).toBe('9');
    expect(keys.get(entityScopeKey(LANTERN, '9'))).toBe('9@s_lantern');
    expect(keys.get(entityScopeKey(stranger, '9'))).toBe('9@s_unknown');
  });
});

describe('resolvePlaceKeys', () => {
  const guilds = [guild('777', 'Cedar place', CEDAR), guild('777', 'Lantern place', LANTERN), guild('100', 'Fuel', HOME)];

  it('names the guild a key stands for, and the key of a guild', () => {
    const keys = resolvePlaceKeys(guilds, ORDER, 's_cedar');
    expect(keys.guildOf('777')?.name).toBe('Cedar place');
    expect(keys.guildOf('777@s_lantern')?.name).toBe('Lantern place');
    expect(keys.guildOf('777@s_nowhere')).toBeUndefined();
    expect(keys.keyOf(guilds[1])).toBe('777@s_lantern');
  });

  it('reads the route’s place as the guild on the selected saved server', () => {
    const onLantern = resolvePlaceKeys(guilds, ORDER, 's_lantern');
    expect(onLantern.currentKey(serverPlace('777'))).toBe('777@s_lantern');
    expect(onLantern.guildOfPlace(serverPlace('777'))?.name).toBe('Lantern place');
    const onCedar = resolvePlaceKeys(guilds, ORDER, 's_cedar');
    expect(onCedar.currentKey(serverPlace('777'))).toBe('777');
    // Neither selected: the one that holds the bare id.
    const neither = resolvePlaceKeys([...guilds].reverse(), ORDER, 's_other');
    expect(neither.currentKey(serverPlace('777'))).toBe('777');
    expect(neither.guildOfPlace(serverPlace('777'))?.name).toBe('Cedar place');
  });

  it('is the id itself for an ordinary place, People for People, and the route’s id when the server is not in the list', () => {
    const keys = resolvePlaceKeys(guilds, ORDER, LOCAL_SERVER_ID);
    expect(keys.currentKey(serverPlace('100'))).toBe('100');
    expect(keys.currentKey(PEOPLE_PLACE)).toBe('people');
    expect(keys.currentKey(serverPlace('555'))).toBe('555');
    expect(keys.guildOfPlace(PEOPLE_PLACE)).toBeUndefined();
  });
});

describe('usePlaceKeys', () => {
  beforeEach(() => {
    useServerListStore.setState({
      activeServerId: null,
      servers: [
        { id: 's_cedar', name: 'Cedar', url: 'https://cedar.example', token: 'a', connected: true },
        { id: 's_lantern', name: 'Lantern', url: 'https://lantern.example', token: 'b', connected: true },
      ],
    });
    mocks.guilds = [guild('777', 'Lantern place', LANTERN), guild('777', 'Cedar place', CEDAR)];
  });

  it('orders by the saved servers and follows the selected one', () => {
    const { result, rerender } = renderHook(() => usePlaceKeys());
    expect(result.current.keys.keyOf(result.current.guilds[0])).toBe('777@s_lantern');
    expect(result.current.keys.keyOf(result.current.guilds[1])).toBe('777');
    expect(result.current.keys.currentKey(serverPlace('777'))).toBe('777');

    useServerListStore.setState({ activeServerId: 's_lantern' });
    rerender();
    expect(result.current.keys.currentKey(serverPlace('777'))).toBe('777@s_lantern');
  });
});
