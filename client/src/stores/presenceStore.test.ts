import { beforeEach, describe, expect, it } from 'vitest';
import { usePresenceStore } from './presenceStore';

function resetStore(): void {
  usePresenceStore.setState({ presences: new Map(), presenceOrder: new Map() });
}

describe('presenceStore.getPresence', () => {
  beforeEach(() => {
    resetStore();
  });

  it('returns the exact scoped presence when available', () => {
    const store = usePresenceStore.getState();
    store.updatePresence({ user_id: 'u1', status: 'online', activities: [] }, 'server-a');
    const presence = usePresenceStore.getState().getPresence('u1', 'server-a');
    expect(presence?.status).toBe('online');
  });

  it('skips Map clones when an identical presence update arrives', () => {
    const store = usePresenceStore.getState();
    store.updatePresence(
      { user_id: 'u1', status: 'online', activities: [{ name: 'Game', type: 0 }] },
      'server-a',
    );
    const before = usePresenceStore.getState().presences;
    const beforeOrder = usePresenceStore.getState().presenceOrder;

    store.updatePresence(
      { user_id: 'u1', status: 'online', activities: [{ name: 'Game', type: 0 }] },
      'server-a',
    );
    expect(usePresenceStore.getState().presences).toBe(before);
    expect(usePresenceStore.getState().presenceOrder).toBe(beforeOrder);
  });

  it('updates when status changes', () => {
    const store = usePresenceStore.getState();
    store.updatePresence({ user_id: 'u1', status: 'online', activities: [] }, 'server-a');
    store.updatePresence({ user_id: 'u1', status: 'idle', activities: [] }, 'server-a');
    expect(usePresenceStore.getState().getPresence('u1', 'server-a')?.status).toBe('idle');
  });

  it('falls back to global presence when scoped presence is missing', () => {
    const store = usePresenceStore.getState();
    store.updatePresence({ user_id: 'u1', status: 'idle', activities: [] });
    const presence = usePresenceStore.getState().getPresence('u1', 'server-a');
    expect(presence?.status).toBe('idle');
  });

  it('falls back to the only known scoped presence when scope is unavailable', () => {
    const store = usePresenceStore.getState();
    store.updatePresence({ user_id: 'u1', status: 'dnd', activities: [] }, 'server-a');
    const presence = usePresenceStore.getState().getPresence('u1');
    expect(presence?.status).toBe('dnd');
  });

  it('falls back to the most recently updated presence when multiple scopes exist and no scope is provided', () => {
    const store = usePresenceStore.getState();
    store.updatePresence({ user_id: 'u1', status: 'online', activities: [] }, 'server-a');
    store.updatePresence({ user_id: 'u1', status: 'idle', activities: [] }, 'server-b');
    const presence = usePresenceStore.getState().getPresence('u1');
    // server-b was written last, so it wins deterministically.
    expect(presence?.status).toBe('idle');
  });

  it('returns a defined presence for a user known only under a different scope', () => {
    const store = usePresenceStore.getState();
    store.updatePresence({ user_id: 'u1', status: 'dnd', activities: [] }, 'server-a');
    const presence = usePresenceStore.getState().getPresence('u1', 'server-b');
    expect(presence?.status).toBe('dnd');
  });
});
