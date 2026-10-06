import { act, renderHook, waitFor } from '@testing-library/react';
import type { AxiosInstance } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useServerConnectionStore } from '../../../stores/serverConnectionStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useUpcomingEvents } from './useUpcomingEvents';

/**
 * Coming up (the sidebar, the Overview, the places list) reads the selected server's calendar.
 * While that server is not connected it waits, with no error to show; it asks once the server
 * is there, and a connection that vanishes at the last moment is the section's own error line.
 */

const mocks = vi.hoisted(() => ({ getApiClient: vi.fn((): AxiosInstance | undefined => undefined) }));
vi.mock('../../../lib/connectionManager', () => ({ connectionManager: { getApiClient: mocks.getApiClient } }));
vi.mock('../../../api/client', () => ({
  apiClient: {},
  extractApiError: (error: { message?: string }) => error?.message ?? 'request failed',
}));
vi.mock('../../../stores/toastStore', () => ({ toast: { error: vi.fn() } }));

const soon = new Date(Date.now() + 3_600_000).toISOString();
const wire = [{ id: '1', name: 'Movie night', scheduled_start: soon, status: 1 }];

function connected() {
  act(() => useServerConnectionStore.getState().set('s_lan', { phase: 'connected', attempts: 0, retryAt: null, endedHere: false }));
}

beforeEach(() => {
  mocks.getApiClient.mockReset();
  mocks.getApiClient.mockReturnValue(undefined);
  useServerConnectionStore.getState().reset();
  useServerListStore.setState({
    activeServerId: 's_lan',
    servers: [{ id: 's_lan', name: 'Lantern', url: 'https://192.168.1.28:8443', token: 'x', connected: false }],
  });
});

describe('useUpcomingEvents on a server that is not connected', () => {
  it('waits, quietly: nothing asked, nothing loaded, no error', () => {
    const { result } = renderHook(() => useUpcomingEvents('g1'));
    expect(result.current).toMatchObject({ events: [], error: null, loaded: false });
    expect(mocks.getApiClient).not.toHaveBeenCalled();
  });

  it('asks once the server is connected', async () => {
    const get = vi.fn().mockResolvedValue({ data: wire });
    const { result } = renderHook(() => useUpcomingEvents('g1'));
    mocks.getApiClient.mockReturnValue({ get } as unknown as AxiosInstance);
    connected();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.events.map((entry) => entry.name)).toEqual(['Movie night']);
    expect(get).toHaveBeenCalledWith('/guilds/g1/events', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('reports a client that is gone at the last moment as the section’s error, not a throw', async () => {
    connected();
    const { result } = renderHook(() => useUpcomingEvents('g1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBe('This server is not connected. Reconnect before trying again.');
  });
});
