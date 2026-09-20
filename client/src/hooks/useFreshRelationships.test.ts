import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFreshRelationships } from './useFreshRelationships';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useUIStore } from '../stores/uiStore';

describe('useFreshRelationships', () => {
  const fetchRelationships = vi.fn(async () => {});

  beforeEach(() => {
    fetchRelationships.mockClear();
    useRelationshipStore.setState({ fetchRelationships });
    useUIStore.setState({ connectionStatus: 'disconnected' });
  });

  it('does not ask before there is a session to ask with', () => {
    renderHook(() => useFreshRelationships());
    expect(fetchRelationships).not.toHaveBeenCalled();
  });

  it('loads once the realtime connection is up, and again after a reconnect', () => {
    renderHook(() => useFreshRelationships());
    act(() => useUIStore.setState({ connectionStatus: 'connected' }));
    expect(fetchRelationships).toHaveBeenCalledTimes(1);

    act(() => useUIStore.setState({ connectionStatus: 'reconnecting' }));
    act(() => useUIStore.setState({ connectionStatus: 'connected' }));
    expect(fetchRelationships).toHaveBeenCalledTimes(2);
  });
});
