import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../types';
const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('./connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('./secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
import { useServerListStore } from '../stores/serverListStore';
import { useReadStateStore } from '../stores/readStateStore';
import { markGuildRead } from './guildActions';
const scope = { serverId: 'a', userId: '42' };
const reply = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
beforeEach(() => {
  clients.clear();
  useReadStateStore.setState({ byAccount: {} });
  useServerListStore.setState({ activeServerId: 'b', servers: ['a', 'b'].map(id => ({ id, name: id, url: `https://${id}.test`, token: 'token', userId: '42', user: { id: '42', username: id } as User, connected: true })) });
  clients.set('a', axios.create()); clients.set('b', axios.create());
});
describe('background guild read actions', () => {
  it('fetches and acknowledges the originating server without switching the visible server', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => reply(config,
      config.url?.endsWith('/visible') ? { channel_ids: ['7'] }
        : config.method === 'get' ? [{ id: '7', type: 0, position: 0, last_message_id: '99' }, { id: 'hidden', type: 0, position: 1, last_message_id: '100' }]
        : {}));
    clients.get('a')!.defaults.adapter = adapter;
    await markGuildRead({ id: '1', scope });
    expect(adapter.mock.calls.every(([config]) => config.baseURL === 'https://a.test/api/v1')).toBe(true);
    const writes = adapter.mock.calls.map(([config]) => config).filter(config => config.method !== 'get');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ url: '/channels/7/read', data: JSON.stringify({ last_message_id: '99' }) });
    expect(useReadStateStore.getState().byAccount[JSON.stringify(['a', '42'])]['7'].last_message_id).toBe('99');
    expect(useReadStateStore.getState().byAccount[JSON.stringify(['b', '42'])]).toBeUndefined();
    expect(useServerListStore.getState().activeServerId).toBe('b');
  });
  it('leaves failed acknowledgements unread and reports the failure', async () => {
    clients.get('a')!.defaults.adapter = async config => {
      if (config.method !== 'get') throw new Error('Permission revoked');
      return reply(config, config.url?.endsWith('/visible') ? { channel_ids: ['7'] } : [{ id: '7', type: 0, position: 0, last_message_id: '99' }]);
    };
    await expect(markGuildRead({ id: '1', scope })).rejects.toThrow('1 of 1 channels could not be marked read: Permission revoked');
    expect(useReadStateStore.getState().byAccount[JSON.stringify(['a', '42'])]).toBeUndefined();
  });
  it('bounds concurrent acknowledgements for large spaces', async () => {
    let concurrent = 0; let maximum = 0; let acknowledged = 0;
    const channels = Array.from({ length: 19 }, (_, id) => ({ id: String(id), type: 0, position: id, last_message_id: '99' }));
    clients.get('a')!.defaults.adapter = async config => {
      if (config.method === 'get') return reply(config, config.url?.endsWith('/visible') ? { channel_ids: channels.map(channel => channel.id) } : channels);
      concurrent++; maximum = Math.max(maximum, concurrent);
      await Promise.resolve();
      concurrent--; acknowledged++;
      return reply(config, {});
    };
    await markGuildRead({ id: '1', scope });
    expect(acknowledged).toBe(19); expect(maximum).toBeLessThanOrEqual(8);
  });
});
