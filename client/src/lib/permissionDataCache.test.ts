import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, User } from '../types';

const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('./connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('./secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
import { useServerListStore } from '../stores/serverListStore';
import { clearPermissionDataCache, fetchGuildRoles, fetchChannelOverwrites, invalidateGuildRoles } from './permissionDataCache';

const reply = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
const role = (name: string): Role => ({ id: '1', name, permissions: '0' }) as Role;

beforeEach(() => {
  clearPermissionDataCache();
  clients.clear();
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({
    id, url: `https://${id}.test`, name: id, connected: true, token: `${id}-token`, userId: '42', user: { id: '42', username: id } as User,
  })) });
  for (const id of ['a', 'b']) clients.set(id, axios.create({ adapter: async config => reply(config, [role(id)]) }));
});

describe('account-scoped permission requests', () => {
  it('does not share cached role data between servers with identical user and guild IDs', async () => {
    expect((await fetchGuildRoles('1'))[0].name).toBe('a');
    useServerListStore.getState().setActive('b');
    expect((await fetchGuildRoles('1'))[0].name).toBe('b');
  });

  it('uses the canonical channel overwrite endpoint on the captured server', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => reply(config, []));
    clients.get('a')!.defaults.adapter = adapter;
    const pending = fetchChannelOverwrites('1');
    useServerListStore.getState().setActive('b');
    await pending;
    expect(adapter.mock.calls[0][0]).toMatchObject({ baseURL: 'https://a.test/api/v1', url: '/channels/1/overwrites' });
  });

  it('an invalidated old failure cannot evict the newer successful request', async () => {
    let fail!: (error: Error) => void;
    const adapter = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockImplementation(async (config: InternalAxiosRequestConfig) => reply(config, [role('current')]));
    clients.get('a')!.defaults.adapter = adapter;
    const old = fetchGuildRoles('1');
    const rejected = expect(old).rejects.toThrow('old failure');
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
    invalidateGuildRoles('1');
    expect((await fetchGuildRoles('1'))[0].name).toBe('current');
    fail(new Error('old failure'));
    await rejected;
    expect((await fetchGuildRoles('1'))[0].name).toBe('current');
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('rejects permission data from a revoked account', async () => {
    let finish!: () => void;
    clients.get('a')!.defaults.adapter = async config => new Promise(resolve => {
      finish = () => resolve(reply(config, [role('old administrator')]));
    });
    const old = fetchGuildRoles('1');
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await useServerListStore.getState().clearSessions();
    finish();
    await rejected;
  });
});
