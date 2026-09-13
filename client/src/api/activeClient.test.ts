import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';

const mocks = vi.hoisted(() => ({
  local: { id: 'local' } as unknown as AxiosInstance,
  remote: { id: 'remote' } as unknown as AxiosInstance,
  selected: null as string | null,
  getApiClient: vi.fn<(id: string) => AxiosInstance | undefined>(),
}));
vi.mock('./client', () => ({ apiClient: mocks.local }));
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: mocks.getApiClient } }));
vi.mock('../stores/serverListStore', () => ({ useServerListStore: { getState: () => ({ activeServerId: mocks.selected }) } }));
import { getApi, getServerApi } from './activeClient';

describe('explicit REST server routing', () => {
  beforeEach(() => { mocks.selected = null; mocks.getApiClient.mockReset(); });
  it('uses the home client only for the home scope', () => {
    expect(getApi()).toBe(mocks.local);
    expect(getServerApi('__local__')).toBe(mocks.local);
  });
  it('uses the selected remote connection', () => {
    mocks.selected = 'remote';
    mocks.getApiClient.mockReturnValue(mocks.remote);
    expect(getApi()).toBe(mocks.remote);
    expect(mocks.getApiClient).toHaveBeenCalledWith('remote');
  });
  it('refuses to substitute home when a remote connection is unavailable', () => {
    mocks.selected = 'remote';
    expect(() => getApi()).toThrow('not connected');
  });
  it('keeps explicit server operations independent of selection changes', () => {
    mocks.getApiClient.mockImplementation(id => id === 'remote' ? mocks.remote : undefined);
    const captured = getServerApi('remote');
    mocks.selected = '__local__';
    expect(getApi()).toBe(mocks.local);
    expect(captured).toBe(mocks.remote);
  });
});
