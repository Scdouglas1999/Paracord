import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild, User } from '../types';
const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('./connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('./secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
import { scopeGuild, useGuildStore } from '../stores/guildStore';
import { useServerListStore } from '../stores/serverListStore';
import { activateGuild, guildLandingPath } from './guildNavigation';
const a = { serverId: 'a', userId: '42' };
const reply = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
const guild = () => scopeGuild({ id: '1', name: 'A', owner_id: '42', default_channel_id: '2' } as Guild, a);
beforeEach(() => {
  clients.clear(); useGuildStore.getState().reset();
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, name: id, url: `https://${id}.test`, token: 'token', userId: '42', user: { id: '42', username: id } as User, connected: true })) });
  clients.set('a', axios.create()); clients.set('b', axios.create());
});
describe('owned guild navigation', () => {
  it('resolves channels on the captured server and then activates that account', async () => {
    const completions: Array<() => void> = [];
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => new Promise<AxiosResponse>(resolve => {
      const data = config.url?.endsWith('/visible') ? { channel_ids: ['2'] } : [{ id: '2', type: 0, position: 0 }];
      completions.push(() => resolve(reply(config, data)));
    }));
    clients.get('a')!.defaults.adapter = adapter;
    const path = guildLandingPath(guild());
    useServerListStore.getState().setActive('b');
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(adapter.mock.calls.every(([config]) => config.baseURL === 'https://a.test/api/v1')).toBe(true);
    completions.forEach(finish => finish());
    expect(await path).toBe('/app/guilds/1/channels/2');
    expect(useServerListStore.getState().activeServerId).toBe('a');
    expect(useGuildStore.getState().selectedGuild).toEqual({ id: '1', scope: a });
  });
  it('opens the building home when no channels are currently visible', async () => {
    clients.get('a')!.defaults.adapter = async config => reply(config, config.url?.endsWith('/visible') ? { channel_ids: [] } : [{ id: '2', type: 0, position: 0 }]);
    expect(await guildLandingPath(guild())).toBe('/app/guilds/1');
  });
  it('does not bypass failed visibility checks or activate another account', async () => {
    clients.get('a')!.defaults.adapter = async () => { throw new Error('visibility unavailable'); };
    useServerListStore.getState().setActive('b');
    await expect(guildLandingPath(guild())).rejects.toThrow('visibility unavailable');
    expect(useServerListStore.getState().activeServerId).toBe('b');
  });
  it('rejects a stale row after the server account changes', () => {
    const reference = guild();
    useServerListStore.getState().setAuthenticatedUser('a', { id: 'replacement', username: 'replacement' } as User);
    useServerListStore.getState().setActive('b');
    expect(() => activateGuild(reference)).toThrow('no longer signed in');
    expect(useServerListStore.getState().activeServerId).toBe('b');
    expect(useGuildStore.getState().selectedGuild).toBeNull();
  });
});
