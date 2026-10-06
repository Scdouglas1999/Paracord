import type { AxiosInstance } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composer reads the upload limit while it renders (`useFileUpload`), so a server with
 * no connection must answer "not known yet", not throw: the throw took the conversation down.
 */

const mocks = vi.hoisted(() => ({ getApiClient: vi.fn((): AxiosInstance | undefined => undefined) }));
vi.mock('../api/client', () => ({ apiClient: { defaults: { baseURL: 'https://home.example/api/v1' } } }));
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: mocks.getApiClient } }));
vi.mock('../api/instance', () => ({ instanceApi: { getInstanceInfo: vi.fn(async () => ({ data: { max_upload_size: 1234 } })) } }));

import { useServerListStore } from './serverListStore';
import { useInstanceStore } from './instanceStore';

beforeEach(() => {
  mocks.getApiClient.mockReset();
  mocks.getApiClient.mockReturnValue(undefined);
  useInstanceStore.setState({ maxUploadSizeByOrigin: {} });
  useServerListStore.setState({ activeServerId: 's_lan', servers: [] });
});

describe('instanceStore for a server that is not connected', () => {
  it('reads the limit as unknown without throwing', () => {
    expect(useInstanceStore.getState().getActiveMaxUploadSize()).toBeNull();
  });

  it('does not fetch, and does not throw, until the server has a client', async () => {
    await expect(useInstanceStore.getState().fetchInstanceInfo()).resolves.toBeUndefined();
    expect(useInstanceStore.getState().maxUploadSizeByOrigin).toEqual({});
  });

  it('knows the limit once the server is connected', async () => {
    mocks.getApiClient.mockReturnValue({ defaults: { baseURL: 'https://lan.example:8443/api/v1' } } as unknown as AxiosInstance);
    await useInstanceStore.getState().fetchInstanceInfo();
    expect(useInstanceStore.getState().getActiveMaxUploadSize()).toBe(1234);
  });
});
