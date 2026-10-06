import { act, renderHook, waitFor } from '@testing-library/react';
import type { AxiosInstance } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useServerConnectionStore } from '../../../stores/serverConnectionStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useGuildTemplates } from './useAddServer';

/**
 * The Add a server sheet is one click from the dock, so it opens whatever the selected server is
 * doing. Its template list is that server's: with no connection it says so (and Reload is there);
 * it used to throw out of its effect, which is the error boundary and the whole window.
 */

const mocks = vi.hoisted(() => ({ getApiClient: vi.fn((): AxiosInstance | undefined => undefined) }));
vi.mock('../../../lib/connectionManager', () => ({ connectionManager: { getApiClient: mocks.getApiClient } }));
vi.mock('../../../api/client', () => ({
  apiClient: {},
  extractApiError: (error: { message?: string }) => error?.message ?? 'request failed',
}));

beforeEach(() => {
  mocks.getApiClient.mockReset();
  mocks.getApiClient.mockReturnValue(undefined);
  useServerConnectionStore.getState().reset();
  useServerListStore.setState({
    activeServerId: 's_lan',
    servers: [{ id: 's_lan', name: 'Lantern', url: 'https://192.168.1.28:8443', token: 'x', connected: false }],
  });
});

describe('useGuildTemplates on a server that is not connected', () => {
  it('reports the missing connection as its error line instead of throwing', async () => {
    const { result } = renderHook(() => useGuildTemplates(true));
    await waitFor(() => expect(result.current.error).toBe('Failed to load templates: This server is not connected. Reconnect before trying again.'));
    expect(result.current.loading).toBe(false);
  });

  it('asks again by itself once the server is connected', async () => {
    const { result } = renderHook(() => useGuildTemplates(true));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    const get = vi.fn().mockResolvedValue({ data: [{ id: 't1', name: 'Club', description: '', creator_id: '1' }] });
    mocks.getApiClient.mockReturnValue({ get } as unknown as AxiosInstance);
    act(() => useServerConnectionStore.getState().set('s_lan', { phase: 'connected', attempts: 0, retryAt: null, endedHere: false }));
    await waitFor(() => expect(result.current.templates).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });
});
