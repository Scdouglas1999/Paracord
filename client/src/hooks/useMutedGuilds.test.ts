import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMutedGuilds } from './useMutedGuilds';
import { useNotificationPreferenceStore } from '../stores/notificationPreferenceStore';
import { useServerListStore } from '../stores/serverListStore';
import { useAuthStore } from '../stores/authStore';
import { accountScopeKey, entityScopeKey } from '../lib/serverScope';
import type { SpaceNotificationSetting } from '../api/notificationSettings';
import type { User } from '../types';
import { setVersionedJson } from '../lib/versionedStorage';
const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
const a = { serverId: 'a', userId: '42' };
const b = { serverId: 'b', userId: '42' };
const state = () => useNotificationPreferenceStore.getState();
const setting = (muted = true, id = '1'): SpaceNotificationSetting => ({ space_id: id, level: 2, muted, muted_now: muted, muted_until: null, suppress_everyone: true });
const response = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
function delay(id = 'a') {
  let finish!: (data: unknown) => void;
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => new Promise<AxiosResponse>(resolve => { finish = data => resolve(response(config, data)); }));
  clients.get(id)!.defaults.adapter = adapter;
  return { adapter, finish: (data: unknown) => finish(data) };
}
beforeEach(() => {
  state().reset(); localStorage.clear(); clients.clear();
  useAuthStore.setState({ user: null, token: null });
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, url: `https://${id}.test`, name: id, token: 'token', userId: '42', user: { id: '42', username: id } as User, connected: true })) });
  for (const id of ['a', 'b']) clients.set(id, axios.create({ adapter: async config => response(config, config.method === 'get' ? { spaces: [setting(id === 'a')], channels: [] } : setting(JSON.parse(config.data).muted)) }));
});
afterEach(() => { state().reset(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('account-owned notification preferences', () => {
  it('keeps colliding guild IDs distinct and exposes only verified accounts', async () => {
    const { result } = renderHook(() => useMutedGuilds());
    await vi.waitFor(() => expect(result.current.mutedGuildKeys).toEqual([entityScopeKey(a, '1')]));
    expect(result.current.isMuted({ id: '1', scope: b })).toBe(false);
    act(() => useServerListStore.getState().updateToken('a', ''));
    expect(result.current.mutedGuildKeys).toEqual([]);
  });
  it('does not assign the old unowned cache to the next signed-in account', async () => {
    setVersionedJson('muted-guilds', ['unowned']);
    const { result } = renderHook(() => useMutedGuilds());
    await vi.waitFor(() => expect(result.current.mutedGuildKeys).toEqual([entityScopeKey(a, '1')]));
    expect(result.current.mutedGuildKeys.some(key => key.includes('unowned'))).toBe(false);
  });
  it('persists only account-qualified settings, excluding pending operations and errors', async () => {
    await state().refresh(a);
    const persisted = JSON.parse(localStorage.getItem('paracord:notification-preferences-by-account')!);
    expect(persisted).toEqual({ version: 1, state: { byAccount: { [accountScopeKey(a)]: { '1': setting() } } } });
  });
  it('unmutes without clearing notification level or suppression preferences', async () => {
    await state().refresh(a);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => response(config, setting(false))); clients.get('a')!.defaults.adapter = adapter;
    await state().setMuted({ id: '1', scope: a }, false);
    expect(adapter.mock.calls[0][0]).toMatchObject({ method: 'put', url: '/guilds/1/notification-settings', data: '{"muted":false}' });
    expect(state().byAccount[accountScopeKey(a)]['1']).toMatchObject({ muted_now: false, level: 2, suppress_everyone: true });
  });
  it('keeps a background mutation on its originating account through a selection switch', async () => {
    const pending = delay(); const save = state().setMuted({ id: '1', scope: a }, true);
    useServerListStore.getState().setActive('b');
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    expect(pending.adapter.mock.calls[0][0].baseURL).toBe('https://a.test/api/v1');
    pending.finish(setting()); await save;
    expect(state().byAccount[accountScopeKey(a)]['1'].muted_now).toBe(true); expect(state().byAccount[accountScopeKey(b)]).toBeUndefined();
  });
  it('leaves confirmed settings intact when a save fails', async () => {
    await state().refresh(a);
    clients.get('a')!.defaults.adapter = async () => { throw new Error('offline'); };
    await expect(state().setMuted({ id: '1', scope: a }, false)).rejects.toThrow('offline');
    expect(state().byAccount[accountScopeKey(a)]['1'].muted_now).toBe(true);
    expect(state().saving[entityScopeKey(a, '1')]).toBe(false);
  });
  it('retains an acknowledged mutation over a delayed older snapshot', async () => {
    let finish!: () => void;
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => config.method === 'get' ? new Promise<AxiosResponse>(resolve => { finish = () => resolve(response(config, { spaces: [setting(true)], channels: [] })); }) : response(config, setting(false)));
    clients.get('a')!.defaults.adapter = adapter;
    const load = state().refresh(a); await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
    await state().setMuted({ id: '1', scope: a }, false);
    finish(); await load;
    expect(state().byAccount[accountScopeKey(a)]['1'].muted_now).toBe(false);
  });
  it('rejects overlapping writes to one space while allowing another account to save', async () => {
    const pending = delay(); const save = state().setMuted({ id: '1', scope: a }, true);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    await expect(state().setMuted({ id: '1', scope: a }, false)).rejects.toThrow('still being saved');
    await state().setMuted({ id: '1', scope: b }, false);
    expect(state().saving[entityScopeKey(a, '1')]).toBe(true);
    pending.finish(setting()); await save;
  });
  it('cancels pending writes on reset and refuses their delayed response', async () => {
    const pending = delay(); const save = state().setMuted({ id: '1', scope: a }, true); const rejected = expect(save).rejects.toThrow();
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    state().reset(); pending.finish(setting()); await rejected;
    expect(state().byAccount).toEqual({}); expect(state().saving).toEqual({});
  });
  it('uses the server-resolved state of a lapsed timed mute', async () => {
    clients.get('a')!.defaults.adapter = async config => response(config, { spaces: [{ ...setting(true), muted_now: false, muted_until: '2020-01-01' }], channels: [] });
    const { result } = renderHook(() => useMutedGuilds());
    await vi.waitFor(() => expect(state().byAccount[accountScopeKey(a)]).toBeDefined());
    expect(result.current.mutedGuildKeys).toEqual([]);
  });
});
