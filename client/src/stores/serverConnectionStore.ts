import { create } from 'zustand';

/**
 * Where each saved server's connection stands, for the UI to say so.
 *
 * Written only by `connectionManager`, which owns the connections; read by the
 * sidebar (a server you are in but cannot see yet), the signed-out banner and
 * the last-place redirect.
 *
 *   connecting  a connect is under way (the first one of a launch, or a retry)
 *   connected   signed in and holding the realtime stream
 *   retrying    the last attempt failed without a verdict on the credential
 *               (unreachable, restarting, a refresh that got no answer); the
 *               next attempt is scheduled for `retryAt`
 *   signed-out  the server refused the credential, or there is none left to
 *               present: nothing will connect until you sign in again
 *   identity-changed
 *               the server presented a certificate other than the one pinned
 *               for it (docs/setup-spec.md §7.4): nothing connects until the
 *               person reviews it and trusts the new identity
 *
 * A server with no entry here has not been asked about yet.
 */
export type ServerConnectionPhase = 'connecting' | 'connected' | 'retrying' | 'signed-out' | 'identity-changed';

export interface ServerConnectionState {
  phase: ServerConnectionPhase;
  /** Consecutive failed attempts since the last success (drives the back-off). */
  attempts: number;
  /** When the next attempt runs (epoch ms), while `retrying`. */
  retryAt: number | null;
  /**
   * While `signed-out`: the server refused a session this app was using, during
   * this run (the banner says so). False for an entry that had no session to
   * begin with; the sidebar still offers to sign in to it.
   */
  endedHere: boolean;
}

interface ServerConnectionStore {
  servers: Record<string, ServerConnectionState>;
  set: (serverId: string, state: ServerConnectionState) => void;
  forget: (serverId: string) => void;
  reset: () => void;
}

export const useServerConnectionStore = create<ServerConnectionStore>()((set) => ({
  servers: {},
  set: (serverId, next) =>
    set((state) => {
      const current = state.servers[serverId];
      if (
        current &&
        current.phase === next.phase &&
        current.attempts === next.attempts &&
        current.retryAt === next.retryAt &&
        current.endedHere === next.endedHere
      ) {
        return state;
      }
      return { servers: { ...state.servers, [serverId]: next } };
    }),
  forget: (serverId) =>
    set((state) => {
      if (!state.servers[serverId]) return state;
      const { [serverId]: _gone, ...rest } = state.servers;
      return { servers: rest };
    }),
  reset: () => set({ servers: {} }),
}));

/** The phase of one server, or null when it has not been asked about yet. */
export function useServerConnectionPhase(serverId: string | null | undefined): ServerConnectionState | null {
  return useServerConnectionStore((state) => (serverId ? state.servers[serverId] ?? null : null));
}
