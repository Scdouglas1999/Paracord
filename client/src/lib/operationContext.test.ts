import axios, { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../types';

const clients = vi.hoisted(() => ({ remote: null as unknown }));
vi.mock('./connectionManager', () => ({ connectionManager: { getApiClient: () => clients.remote } }));
vi.mock('./secureStorage', () => ({ secureSet: vi.fn(), secureGet: vi.fn(), secureDelete: vi.fn() }));
import { useServerListStore } from '../stores/serverListStore';
import { captureOperationContext, OperationExpiredError } from './operationContext';
import { createApiClient } from '../api/client';
import { acceptDatabaseHistoryEpoch, clearDatabaseHistoryMemory, DATABASE_HISTORY_HEADER, getDatabaseHistoryEpoch, registerHistoryReconciler } from './databaseHistory';

const oldHistory = '7257b8f7-610e-4a8b-a20c-5a94a7b98428';
const newHistory = '31349d45-0b51-4c83-b41b-49ac76d648ce';
const scope = { serverId: 'a', userId: '42' };

const user = (id: string): User => ({ id, username: id, discriminator: 0, bot: false, system: false, flags: 0, created_at: '' });
const response = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });

function notification() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear(); clearDatabaseHistoryMemory();
  useServerListStore.setState({ activeServerId: 'a', servers: [
    { id: 'a', url: 'https://a.test', name: 'A', token: 'a-token', userId: '42', user: user('42'), connected: true },
    { id: 'b', url: 'https://b.test', name: 'B', token: 'b-token', userId: '42', user: user('42'), connected: true },
  ] });
  clients.remote = axios.create();
});

describe('operation ownership across asynchronous work', () => {
  it('keeps its server when selection changes before the request is sent', async () => {
    const adapter = vi.fn<AxiosAdapter>(async config => response(config, 'sent to A'));
    clients.remote = createApiClient('https://a.test/api/v1', () => 'a-token');
    (clients.remote as ReturnType<typeof axios.create>).defaults.adapter = adapter;
    const operation = captureOperationContext();
    useServerListStore.getState().setActive('b');
    const result = await operation.request({ method: 'POST', url: '/channels/1/messages', data: { content: 'A only' } });
    expect(result.data).toBe('sent to A');
    expect(adapter.mock.calls[0][0]).toMatchObject({ baseURL: 'https://a.test/api/v1', headers: { Authorization: 'Bearer a-token' } });
    expect(operation.scope).toEqual({ serverId: 'a', userId: '42' });
    operation.dispose();
  });

  it('rejects stale responses after logout and login as the same user', async () => {
    let complete!: () => void;
    const started = notification();
    (clients.remote as ReturnType<typeof axios.create>).defaults.adapter = async config => {
      started.resolve();
      return new Promise(resolve => { complete = () => resolve(response(config, 'old private data')); });
    };
    const operation = captureOperationContext();
    const result = operation.request({ url: '/channels/1/messages' });
    const rejected = expect(result).rejects.toThrow();
    await started.promise;
    useServerListStore.getState().updateToken('a', '');
    useServerListStore.getState().updateToken('a', 'new-token');
    complete();
    await rejected;
    expect(operation.signal.aborted).toBe(true);
    expect(() => operation.assertCurrent()).toThrow(OperationExpiredError);
  });

  it('expires when the account or server URL changes, but permits token rotation', () => {
    const operation = captureOperationContext();
    useServerListStore.getState().updateToken('a', 'rotated');
    expect(() => operation.assertCurrent()).not.toThrow();
    useServerListStore.getState().setAuthenticatedUser('a', user('different'));
    expect(() => operation.assertCurrent()).toThrow(OperationExpiredError);
    const next = captureOperationContext();
    useServerListStore.getState().updateServerInfo('a', { url: 'https://replacement.test' });
    expect(() => next.assertCurrent()).toThrow(OperationExpiredError);
  });

  it('cannot refresh or clear a replacement account after an old request returns 401', async () => {
    const refreshed = vi.fn();
    const authFailed = vi.fn();
    const client = createApiClient('https://a.test/api/v1', () => useServerListStore.getState().getServer('a')?.token ?? null, refreshed, authFailed, undefined, () => 'old-refresh');
    clients.remote = client;
    let finishRefresh!: () => void;
    const refreshing = notification();
    client.defaults.adapter = async config => {
      if (config.url === '/auth/refresh') {
        refreshing.resolve();
        return new Promise(resolve => { finishRefresh = () => resolve(response(config, { token: 'stale-token' })); });
      }
      throw new AxiosError('expired', 'ERR_BAD_REQUEST', config, undefined, { ...response(config, {}), status: 401 });
    };
    const operation = captureOperationContext();
    const result = operation.request({ url: '/channels/1/messages' });
    const rejected = expect(result).rejects.toThrow();
    await refreshing.promise;
    useServerListStore.getState().setAuthenticatedUser('a', user('replacement'));
    useServerListStore.getState().updateToken('a', 'replacement-token');
    finishRefresh();
    await rejected;
    expect(refreshed).not.toHaveBeenCalled();
    expect(authFailed).not.toHaveBeenCalled();
    expect(useServerListStore.getState().getServer('a')?.token).toBe('replacement-token');
  });

  it('rejects external URLs instead of attaching account credentials', async () => {
    const operation = captureOperationContext();
    await expect(operation.request({ url: 'https://elsewhere.test/messages' })).rejects.toThrow('server-relative');
    await expect(operation.request({ url: '//elsewhere.test/messages' })).rejects.toThrow('server-relative');
    operation.dispose();
  });

  it('pins request headers to accepted history and rejects a mismatching reply without adopting it', async () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    const reconcile = vi.fn();
    const unsubscribe = registerHistoryReconciler(reconcile);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({ ...response(config, 'wrong history'), headers: new AxiosHeaders({ [DATABASE_HISTORY_HEADER]: newHistory }) }));
    (clients.remote as ReturnType<typeof axios.create>).defaults.adapter = adapter;
    const operation = captureOperationContext();
    await expect(operation.request({ url: '/channels/1', headers: { [DATABASE_HISTORY_HEADER]: newHistory } })).rejects.toThrow('Database history changed');
    expect(adapter.mock.calls[0][0].headers.get(DATABASE_HISTORY_HEADER)).toBe(oldHistory);
    expect(operation.historyEpoch).toBe(oldHistory);
    expect(operation.signal.aborted).toBe(true);
    expect(getDatabaseHistoryEpoch(scope)).toBe(oldHistory);
    expect(reconcile).toHaveBeenCalledWith(scope);
    unsubscribe();
  });

  it('aborts old history before late replies while retaining operations on another server', async () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    const unrelated = captureOperationContext('b');
    let finish!: () => void;
    const started = notification();
    (clients.remote as ReturnType<typeof axios.create>).defaults.adapter = async config => {
      started.resolve();
      return new Promise(resolve => { finish = () => resolve({ ...response(config, 'old snapshot'), headers: new AxiosHeaders({ [DATABASE_HISTORY_HEADER]: oldHistory }) }); });
    };
    const operation = captureOperationContext('a');
    const pending = operation.request({ url: '/channels/1' });
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    acceptDatabaseHistoryEpoch(scope, newHistory);
    expect(operation.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
    expect(() => unrelated.assertCurrent()).not.toThrow();
    finish(); await rejected;
    expect(getDatabaseHistoryEpoch(scope)).toBe(newHistory);
    unrelated.dispose();
  });

  it('requests a handshake after HISTORY_CHANGED and never retries a mutation into the replacement history', async () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    const reconcile = vi.fn(); const unsubscribe = registerHistoryReconciler(reconcile);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError('history replaced', 'ERR_BAD_REQUEST', config, undefined, { ...response(config, { code: 'HISTORY_CHANGED' }), status: 409, headers: new AxiosHeaders({ [DATABASE_HISTORY_HEADER]: newHistory }) });
    });
    (clients.remote as ReturnType<typeof axios.create>).defaults.adapter = adapter;
    const operation = captureOperationContext();
    await expect(operation.request({ method: 'DELETE', url: '/channels/1/messages/2' })).rejects.toThrow('history replaced');
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(scope);
    expect(operation.signal.aborted).toBe(true);
    expect(getDatabaseHistoryEpoch(scope)).toBe(oldHistory);
    unsubscribe();
  });

  it('requires a matching history response header once a history is known', async () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    (clients.remote as ReturnType<typeof axios.create>).defaults.adapter = async config => response(config, 'unproven');
    const operation = captureOperationContext();
    await expect(operation.request({ url: '/channels/1' })).rejects.toThrow('Database history changed');
  });

  it('pins derived token refresh to the same history and rejects replacement history before saving or clearing credentials', async () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    const refreshed = vi.fn(); const authFailed = vi.fn();
    const client = createApiClient('https://a.test/api/v1', () => 'a-token', refreshed, authFailed, undefined, () => 'refresh-token');
    clients.remote = client;
    const urls: string[] = [];
    client.defaults.adapter = async config => {
      urls.push(config.url!);
      expect(config.headers.get(DATABASE_HISTORY_HEADER)).toBe(oldHistory);
      if (config.url === '/auth/refresh') {
        return { ...response(config, { token: 'wrong-history-token' }), headers: new AxiosHeaders({ [DATABASE_HISTORY_HEADER]: newHistory }) };
      }
      throw new AxiosError('expired', 'ERR_BAD_REQUEST', config, undefined, { ...response(config, {}), status: 401, headers: new AxiosHeaders({ [DATABASE_HISTORY_HEADER]: oldHistory }) });
    };
    const operation = captureOperationContext();
    await expect(operation.request({ url: '/channels/1/messages' })).rejects.toThrow('Database history changed');
    expect(urls).toEqual(['/channels/1/messages', '/auth/refresh']);
    expect(refreshed).not.toHaveBeenCalled();
    expect(authFailed).not.toHaveBeenCalled();
    expect(useServerListStore.getState().getServer('a')?.token).toBe('a-token');
    expect(getDatabaseHistoryEpoch(scope)).toBe(oldHistory);
  });
});
