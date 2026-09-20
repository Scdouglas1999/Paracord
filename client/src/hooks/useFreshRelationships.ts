import { useEffect } from 'react';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useUIStore } from '../stores/uiStore';

/**
 * Load relationships once there is a session to load them with.
 *
 * The shell, Home and Friends each used to fetch on mount. Straight after a
 * sign-in the shell mounts a beat before the server session exists, so every
 * one of those fetches came back 401 and raised its own "Failed to load
 * relationships" toast — for a list that then loaded fine. The realtime
 * connection is the one signal that holds in both the desktop (per-server
 * token) and the browser (cookie) builds, so the load waits for it, and runs
 * again after a reconnect, when RELATIONSHIP_* events may have been missed.
 */
export function useFreshRelationships() {
  const connected = useUIStore((s) => s.connectionStatus) === 'connected';
  useEffect(() => {
    if (!connected) return;
    void useRelationshipStore.getState().fetchRelationships();
  }, [connected]);
}
