import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useServerConnectionStore } from '../stores/serverConnectionStore';
import { useServerListStore } from '../stores/serverListStore';
import { useServerReadiness, useServerReady } from './useServerReady';

/** When REST to the selected server can be made: the home server always, a saved server once it is connected. */

const entry = { id: 's_lan', name: 'Lantern', url: 'https://192.168.1.28:8443', token: 'x', connected: false };

beforeEach(() => {
  useServerConnectionStore.getState().reset();
  useServerListStore.setState({ servers: [entry], activeServerId: null });
});

describe('useServerReady', () => {
  it('is always ready for the home server (no selection, or the home scope)', () => {
    expect(renderHook(() => useServerReady()).result.current).toBe(true);
    act(() => useServerListStore.setState({ activeServerId: '__local__' }));
    expect(renderHook(() => useServerReady()).result.current).toBe(true);
  });

  it('waits for a saved server until its connection says connected, through every phase before', () => {
    useServerListStore.setState({ activeServerId: 's_lan' });
    const { result } = renderHook(() => useServerReadiness());
    // Not asked about yet.
    expect(result.current).toMatchObject({ ready: false, phase: null, server: { id: 's_lan' } });
    for (const phase of ['connecting', 'retrying', 'signed-out'] as const) {
      act(() => useServerConnectionStore.getState().set('s_lan', { phase, attempts: 1, retryAt: null, endedHere: false }));
      expect(result.current).toMatchObject({ ready: false, phase });
    }
    act(() => useServerConnectionStore.getState().set('s_lan', { phase: 'connected', attempts: 0, retryAt: null, endedHere: false }));
    expect(result.current).toMatchObject({ ready: true, phase: 'connected' });
  });

  it('follows the selection: another saved server has its own phase', () => {
    useServerListStore.setState({
      servers: [entry, { ...entry, id: 's_other', name: 'Other' }],
      activeServerId: 's_lan',
    });
    useServerConnectionStore.getState().set('s_other', { phase: 'connected', attempts: 0, retryAt: null, endedHere: false });
    const { result } = renderHook(() => useServerReady());
    expect(result.current).toBe(false);
    act(() => useServerListStore.setState({ activeServerId: 's_other' }));
    expect(result.current).toBe(true);
  });
});
