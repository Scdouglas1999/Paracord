import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayEvents } from '../gateway/events';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import type { User } from '../types';
import { acceptDatabaseHistoryEpoch, clearDatabaseHistoryMemory, getDatabaseHistoryEpoch, registerAccountHistoryReset, requestHistoryReconciliation } from './databaseHistory';
import { dispatchGatewayEvent } from '../gateway/dispatch';
vi.mock('../gateway/dispatch', () => ({ dispatchGatewayEvent: vi.fn() }));
vi.mock('./messages/accountMessagingRuntime', () => ({ pauseAccountMessagingForRecovery: vi.fn() }));
import {
  connectionManager,
  warnMalformedFrame,
  LOCAL_SERVER_ID,
  type ServerConnection,
} from './connectionManager';

function makeConnection(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    serverId: '__test__',
    serverUrl: 'http://localhost:8090',
    apiClient: {} as ServerConnection['apiClient'],
    ws: null,
    eventSource: null,
    streamUrl: null,
    heartbeatTimer: null,
    heartbeatInterval: null,
    sseWatchdogTimer: null,
    lastFrameTs: 0,
    sequence: 7,
    sessionId: 'session-before',
    realtimeCursor: null,
    reconnectAttempts: 4,
    reconnectTimer: null,
    allowReconnect: true,
    connected: true,
    connecting: false,
    lastHeartbeatSentAtMs: 0,
    missedAcks: 0,
    connectionLatency: 0,
    pendingMessages: [],
    ...overrides,
  };
}

// Private surface of the singleton that the tests drive directly.
type ManagerInternals = {
  connectLocalInternal: () => Promise<void>;
  connections: Map<string, ServerConnection>;
  offline: boolean;
  handleDispatch: (conn: ServerConnection, event: string, data: unknown) => void;
  handlePayload: (conn: ServerConnection, payload: { op: number; d?: unknown; t?: string; s?: number }) => void;
  reconnectGateway: (conn: ServerConnection) => void;
  connectRealtime: (conn: ServerConnection) => void;
  connectRealtimeSse: (conn: ServerConnection) => void;
  startSseWatchdog: (conn: ServerConnection, es: EventSource) => void;
};

const manager = connectionManager as unknown as ManagerInternals;
const scope = { serverId: '__test__', userId: '42' };
const oldHistory = '7257b8f7-610e-4a8b-a20c-5a94a7b98428';
const newHistory = '31349d45-0b51-4c83-b41b-49ac76d648ce';
beforeEach(() => {
  localStorage.clear(); clearDatabaseHistoryMemory();
  vi.mocked(dispatchGatewayEvent).mockClear();
  useServerListStore.setState({ servers: [{ id: '__test__', name: 'Test server', url: 'http://localhost:8090', connected: true, token: 'token', userId: '42', user: { id: '42', username: 'owner' } as User }] });
});

/** Register a connection for the duration of a test, then clean up. */
function withConnection<T>(conn: ServerConnection, fn: () => T): T {
  manager.connections.set(conn.serverId, conn);
  try {
    return fn();
  } finally {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    manager.connections.delete(conn.serverId);
  }
}

/** Like withConnection, but awaits an async body before cleanup. */
async function withConnectionAsync(
  conn: ServerConnection,
  fn: () => Promise<void>,
): Promise<void> {
  manager.connections.set(conn.serverId, conn);
  try {
    await fn();
  } finally {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    manager.connections.delete(conn.serverId);
  }
}

describe('connectionManager gateway lifecycle', () => {
  it.each([GatewayEvents.RESUMED, GatewayEvents.MESSAGE_CREATE])('closes %s cleanly when saved history cannot be read', event => {
    localStorage.setItem('paracord:database-history:["__test__","42"]', 'corrupt');
    const close = vi.fn();
    const conn = makeConnection({ eventSource: { close } as unknown as EventSource });
    withConnection(conn, () => {
      expect(() => manager.handleDispatch(conn, event, {})).not.toThrow();
      expect(manager.connections.has(conn.serverId)).toBe(false);
    });
    expect(close).toHaveBeenCalledOnce();
    expect(dispatchGatewayEvent).not.toHaveBeenCalled();
  });

  it('flushes queued messages and resets reconnect attempts after RESUMED', () => {
    const sent: string[] = [];
    const conn = makeConnection({
      ws: {
        readyState: WebSocket.OPEN,
        send: vi.fn((payload: string) => sent.push(payload)),
      } as unknown as WebSocket,
      pendingMessages: [
        { op: 3, d: { status: 'online' } },
        { op: 4, d: { guild_id: '1', channel_id: '2' } },
      ],
    });

    withConnection(conn, () => {
      manager.handleDispatch(conn, GatewayEvents.RESUMED, { session_id: 'session-after' });
    });

    expect(conn.sessionId).toBe('session-after');
    expect(conn.reconnectAttempts).toBe(0);
    expect(conn.pendingMessages).toEqual([]);
    expect(sent.map((payload) => JSON.parse(payload))).toEqual([
      { op: 3, d: { status: 'online' } },
      { op: 4, d: { guild_id: '1', channel_id: '2' } },
    ]);
  });

  it('accepts lower restored history through a currently owned READY even with the same SSE session ID', () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    const reset = vi.fn(); registerAccountHistoryReset('connection-test', reset);
    const conn = makeConnection({ historyEpoch: oldHistory, accountId: '42', pendingMessages: [{ op: 4, d: { channel_id: 'old' } }] });
    withConnection(conn, () => manager.handleDispatch(conn, GatewayEvents.READY, { user: { id: '42' }, session_id: 'session-before', database_history_epoch: newHistory }));
    expect(getDatabaseHistoryEpoch(scope)).toBe(newHistory);
    expect(conn.historyEpoch).toBe(newHistory);
    expect(conn.sessionId).toBe('session-before');
    expect(conn.pendingMessages).toEqual([]);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(dispatchGatewayEvent).toHaveBeenCalledWith('__test__', 'READY', expect.objectContaining({ database_history_epoch: newHistory }));
  });

  it('does not reset a healthy READY or RESUMED for the same accepted history', () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    const reset = vi.fn(); registerAccountHistoryReset('connection-test', reset);
    const conn = makeConnection({ historyEpoch: oldHistory, accountId: '42' });
    withConnection(conn, () => {
      manager.handleDispatch(conn, GatewayEvents.READY, { user: { id: '42' }, database_history_epoch: oldHistory, session_id: 'session' });
      manager.handleDispatch(conn, GatewayEvents.RESUMED, { database_history_epoch: oldHistory, session_id: 'session' });
    });
    expect(reset).not.toHaveBeenCalled();
    expect(dispatchGatewayEvent).toHaveBeenCalledTimes(2);
  });

  it('rejects stale connection handshakes and mismatched account projections', () => {
    acceptDatabaseHistoryEpoch(scope, newHistory);
    const old = makeConnection({ historyEpoch: oldHistory });
    const current = makeConnection({ historyEpoch: newHistory, accountId: '42' });
    withConnection(current, () => {
      manager.handleDispatch(old, GatewayEvents.READY, { user: { id: '42' }, database_history_epoch: oldHistory });
      manager.handleDispatch(current, GatewayEvents.READY, { user: { id: 'other' }, database_history_epoch: oldHistory });
    });
    expect(getDatabaseHistoryEpoch(scope)).toBe(newHistory);
    expect(dispatchGatewayEvent).not.toHaveBeenCalled();
  });

  it('requires a fresh READY when RESUMED identifies a changed history', () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    const close = vi.fn();
    const conn = makeConnection({ historyEpoch: oldHistory, accountId: '42', ws: { close } as unknown as WebSocket });
    withConnection(conn, () => {
      manager.handleDispatch(conn, GatewayEvents.RESUMED, { database_history_epoch: newHistory, session_id: 'same-session' });
      expect(conn.sessionId).toBeNull();
      expect(conn.historyEpoch).toBeUndefined();
      expect(conn.reconnectTimer).not.toBeNull();
      manager.handleDispatch(conn, GatewayEvents.MESSAGE_CREATE, { id: '1', channel_id: '2' });
    });
    expect(close).toHaveBeenCalledOnce();
    expect(dispatchGatewayEvent).not.toHaveBeenCalled();
  });

  it('closes a mismatching HTTP history transport and discards buffered commands without adopting a reply epoch', () => {
    acceptDatabaseHistoryEpoch(scope, oldHistory);
    const close = vi.fn();
    const conn = makeConnection({ historyEpoch: oldHistory, accountId: '42', eventSource: { close } as unknown as EventSource, pendingMessages: [{ op: 4 }] });
    withConnection(conn, () => {
      requestHistoryReconciliation(scope);
      expect(conn.reconnectTimer).not.toBeNull();
      expect(conn.pendingMessages).toEqual([]);
      expect(conn.sequence).toBeNull();
      expect(conn.realtimeCursor).toBeNull();
      manager.handleDispatch(conn, GatewayEvents.MESSAGE_CREATE, { id: '1', channel_id: '2' });
    });
    expect(close).toHaveBeenCalledOnce();
    expect(getDatabaseHistoryEpoch(scope)).toBe(oldHistory);
    expect(dispatchGatewayEvent).not.toHaveBeenCalled();
  });
});

describe('connectionManager reconnect backoff', () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;
  const originalOffline = manager.offline;

  beforeEach(() => {
    vi.useFakeTimers();
    manager.offline = false;
    // Prevent real network by stubbing the actual (re)connect entry point.
    connectSpy = vi.spyOn(
      manager as unknown as { connectRealtime: (c: ServerConnection) => void },
      'connectRealtime',
    ).mockImplementation(() => {});
  });

  afterEach(() => {
    connectSpy.mockRestore();
    manager.offline = originalOffline;
    vi.useRealTimers();
  });

  it('retries immediately on the first attempt then backs off exponentially', () => {
    const conn = makeConnection({ reconnectAttempts: 0, connected: false });

    withConnection(conn, () => {
      // Attempt 0 -> immediate (0ms) retry.
      manager.reconnectGateway(conn);
      expect(conn.reconnectAttempts).toBe(1);
      expect(conn.reconnectTimer).not.toBeNull();
      expect(connectSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(0);
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(conn.reconnectTimer).toBeNull();

      // Attempt 1 -> 1000ms.
      manager.reconnectGateway(conn);
      expect(conn.reconnectAttempts).toBe(2);
      vi.advanceTimersByTime(999);
      expect(connectSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(connectSpy).toHaveBeenCalledTimes(2);

      // Attempt 2 -> 2000ms.
      manager.reconnectGateway(conn);
      vi.advanceTimersByTime(1999);
      expect(connectSpy).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(connectSpy).toHaveBeenCalledTimes(3);
    });
  });

  it('caps the backoff delay at 30s', () => {
    // attempt-1 clamps to 5, so delay = min(1000 * 2^5, 30000) = 30000.
    const conn = makeConnection({ reconnectAttempts: 10, connected: false });

    withConnection(conn, () => {
      manager.reconnectGateway(conn);
      vi.advanceTimersByTime(29999);
      expect(connectSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('does not schedule a reconnect while offline', () => {
    manager.offline = true;
    const conn = makeConnection({ reconnectAttempts: 0, connected: false });

    withConnection(conn, () => {
      manager.reconnectGateway(conn);
      expect(conn.reconnectTimer).toBeNull();
      vi.runOnlyPendingTimers();
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });

  it('does not double-schedule when a reconnect timer already exists', () => {
    const conn = makeConnection({ reconnectAttempts: 2, connected: false });

    withConnection(conn, () => {
      manager.reconnectGateway(conn);
      const firstTimer = conn.reconnectTimer;
      const attemptsAfterFirst = conn.reconnectAttempts;
      manager.reconnectGateway(conn);
      expect(conn.reconnectTimer).toBe(firstTimer);
      expect(conn.reconnectAttempts).toBe(attemptsAfterFirst);
    });
  });
});

describe('connectionManager control opcodes (RT v2 / SSE)', () => {
  let reconnectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reconnectSpy = vi.spyOn(
      manager as unknown as { reconnectGateway: (c: ServerConnection) => void },
      'reconnectGateway',
    ).mockImplementation(() => {});
  });

  afterEach(() => {
    reconnectSpy.mockRestore();
  });

  it('op 7 (RECONNECT) tears down the EventSource and reconnects', () => {
    const close = vi.fn();
    const conn = makeConnection({
      eventSource: { close } as unknown as EventSource,
      connected: true,
      connecting: false,
    });

    withConnection(conn, () => {
      manager.handlePayload(conn, { op: 7 });
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(conn.eventSource).toBeNull();
    expect(conn.connected).toBe(false);
    expect(conn.connecting).toBe(false);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('op 9 (INVALID_SESSION) clears the session, tears down, and reconnects', () => {
    const close = vi.fn();
    const conn = makeConnection({
      eventSource: { close } as unknown as EventSource,
      sessionId: 'stale-session',
      connected: true,
    });

    withConnection(conn, () => {
      manager.handlePayload(conn, { op: 9 });
    });

    expect(conn.sessionId).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    expect(conn.eventSource).toBeNull();
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
  });
});

describe('connectionManager duplicate SSE guard', () => {
  let esInstances: number;
  let OriginalEventSource: typeof EventSource;

  beforeEach(() => {
    esInstances = 0;
    OriginalEventSource = globalThis.EventSource;
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      constructor() {
        esInstances += 1;
      }
      addEventListener() {}
      close() {}
    }
    // @ts-expect-error test double
    globalThis.EventSource = FakeEventSource;
  });

  afterEach(() => {
    globalThis.EventSource = OriginalEventSource;
  });

  it('does not open a second EventSource for another connection to the same URL', () => {
    // The already-connected primary connection to the shared URL.
    const primary = makeConnection({
      serverId: 'primary',
      serverUrl: 'http://localhost:8090',
      eventSource: { close() {} } as unknown as EventSource,
      connected: true,
      connecting: false,
    });
    // A second connection (e.g. LOCAL) pointing at the exact same URL.
    const secondary = makeConnection({
      serverId: LOCAL_SERVER_ID,
      serverUrl: 'http://localhost:8090/',
      eventSource: null,
      connected: false,
      connecting: false,
    });

    manager.connections.set(primary.serverId, primary);
    manager.connections.set(secondary.serverId, secondary);
    // Give the local connection a token so the SSE path isn't skipped for that reason.
    vi.spyOn(
      manager as unknown as { tokenForConnection: (c: ServerConnection) => string | null },
      'tokenForConnection',
    ).mockReturnValue('tok');

    try {
      manager.connectRealtimeSse(secondary);
    } finally {
      manager.connections.delete(primary.serverId);
      manager.connections.delete(secondary.serverId);
      vi.restoreAllMocks();
    }

    // The duplicate-URL guard should have short-circuited before creating an ES.
    expect(esInstances).toBe(0);
    expect(secondary.eventSource).toBeNull();
    expect(secondary.connected).toBe(true);
  });
});

describe('connectionManager malformed frame diagnostics', () => {
  it('logs at most one rate-limited warning per window and never throws', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Two malformed frames inside the throttle window -> a single warning.
      expect(() => warnMalformedFrame('sse', '{not valid json')).not.toThrow();
      expect(() => warnMalformedFrame('ws', '  binary garbage')).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [firstMessage] = warnSpy.mock.calls[0];
      expect(String(firstMessage)).toContain('malformed sse');
      // The full payload is never logged, only a truncated prefix.
      expect(String(firstMessage)).not.toContain('binary garbage');

      // Once the throttle window elapses, a fresh warning is emitted.
      vi.advanceTimersByTime(10_000);
      warnMalformedFrame('ws', 'still broken');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('connectionManager healthy-connection skip', () => {
  type Internals = {
    connectServerInternal: (id: string) => Promise<void>;
    isConnectionHealthy: (c: ServerConnection) => boolean;
    connectRealtime: (c: ServerConnection) => void;
  };
  const internals = manager as unknown as Internals;

  it('treats a live SSE connection as healthy and skips reconnect', async () => {
    const connectSpy = vi.spyOn(internals, 'connectRealtime').mockImplementation(() => {});
    const conn = makeConnection({
      serverId: 'healthy',
      connected: true,
      connecting: false,
      eventSource: { close() {} } as unknown as EventSource,
    });

    try {
      await withConnectionAsync(conn, async () => {
        expect(internals.isConnectionHealthy(conn)).toBe(true);
        await internals.connectServerInternal('healthy');
      });
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
    }
  });

  // Sign out, and the entry's token goes but the connection object stays. Every
  // later connectAll() then took the "already connected" branch, called
  // connectRealtime, got "no token for server", and never reached the code that
  // could authenticate again — so unlocking a device identity produced no
  // /auth/challenge at all and the app said it could not sign in with its key.
  it('drops a connection whose credential is gone so it can sign in again', async () => {
    const connectSpy = vi.spyOn(internals, 'connectRealtime').mockImplementation(() => {});
    useServerListStore.setState({
      servers: [{ id: 'signed-out', name: 'Signed out', url: 'http://localhost:8090', connected: false, token: '', refreshToken: null, userId: '42' }],
    });
    useAuthStore.setState({ token: null });
    const conn = makeConnection({ serverId: 'signed-out', connected: true, connecting: false, eventSource: { close() {} } as unknown as EventSource });

    try {
      await withConnectionAsync(conn, async () => {
        // It reaches the credential path and fails there, rather than
        // reporting the dead connection as already connected.
        await expect(internals.connectServerInternal('signed-out')).rejects.toThrow(/not unlocked/);
      });
      expect(connectSpy).not.toHaveBeenCalled();
      expect(manager.connections.has('signed-out')).toBe(false);
    } finally {
      connectSpy.mockRestore();
    }
  });

  it('reconnects when an existing connection is stale', async () => {
    const connectSpy = vi.spyOn(internals, 'connectRealtime').mockImplementation(() => {});
    const conn = makeConnection({
      serverId: 'stale',
      connected: false,
      connecting: false,
      eventSource: null,
      ws: null,
    });

    try {
      await withConnectionAsync(conn, async () => {
        expect(internals.isConnectionHealthy(conn)).toBe(false);
        await internals.connectServerInternal('stale');
      });
      expect(connectSpy).toHaveBeenCalledTimes(1);
    } finally {
      connectSpy.mockRestore();
    }
  });
});

// "Your session ended on the instance" printed under "the instance is
// restarting" — because a second entry for the same instance under another
// spelling held an older token, and its 401 was read as news about the live
// session. A refusal is only ever news about the credential that was refused.
describe('connectionManager stale duplicate entries', () => {
  type Internals = { entryCarriesHomeCredential: (id: string) => boolean };
  const internals = manager as unknown as Internals;

  beforeEach(() => {
    useServerListStore.setState({
      servers: [
        { id: 'live', name: 'Home', url: 'http://127.0.0.1:18640', connected: true, token: 'home-token', refreshToken: 'home-refresh', userId: '42' },
        { id: 'stale', name: 'Home again', url: 'http://localhost:18640', connected: false, token: 'yesterdays-token', refreshToken: 'yesterdays-refresh', userId: '42' },
      ],
    });
    useAuthStore.setState({ token: 'home-token' });
  });

  it('recognizes the entry carrying the live home credential', () => {
    expect(internals.entryCarriesHomeCredential('live')).toBe(true);
  });

  it('does not let a stale duplicate speak for the home session', () => {
    expect(internals.entryCarriesHomeCredential('stale')).toBe(false);
  });

  it('does not let an entry that is not in the list speak for it either', () => {
    expect(internals.entryCarriesHomeCredential('gone')).toBe(false);
  });
});

describe('connectionManager SSE watchdog', () => {
  let reconnectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    reconnectSpy = vi.spyOn(
      manager as unknown as { reconnectGateway: (c: ServerConnection) => void },
      'reconnectGateway',
    ).mockImplementation(() => {});
  });

  afterEach(() => {
    reconnectSpy.mockRestore();
    vi.useRealTimers();
  });

  it('marks the stream stale and reconnects after the no-frame timeout', () => {
    const close = vi.fn();
    const es = { close } as unknown as EventSource;
    const conn = makeConnection({ eventSource: es, connected: true, connectionLatency: 42 });

    withConnection(conn, () => {
      manager.startSseWatchdog(conn, es);
      expect(conn.sseWatchdogTimer).not.toBeNull();

      // Silence past the tolerated gap -> stale. The server heartbeats an idle
      // stream every 15s, so this is four missed heartbeats.
      vi.advanceTimersByTime(75_000);

      expect(reconnectSpy).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(conn.eventSource).toBeNull();
      expect(conn.connected).toBe(false);
      expect(conn.connectionLatency).toBe(42);
      expect(conn.sseWatchdogTimer).toBeNull();
    });
  });

  it('measures real silence, so a stream that keeps speaking is never replaced', () => {
    // The watchdog used to count its own ticks rather than look at the clock,
    // which made "is this stream alive?" a question about how many times a
    // timer had fired instead of about the stream. A frame arriving between
    // ticks is the only thing that means anything, and the gap since the last
    // one is the whole answer.
    const es = { close: vi.fn() } as unknown as EventSource;
    const conn = makeConnection({ eventSource: es, connected: true });

    withConnection(conn, () => {
      manager.startSseWatchdog(conn, es);

      // A quiet stream that is nonetheless heartbeating, for half an hour.
      for (let elapsed = 0; elapsed < 30 * 60_000; elapsed += 15_000) {
        vi.advanceTimersByTime(15_000);
        conn.lastFrameTs = Date.now();
      }
      expect(reconnectSpy).not.toHaveBeenCalled();

      // Then it genuinely stops.
      vi.advanceTimersByTime(75_000);
      expect(reconnectSpy).toHaveBeenCalledTimes(1);

      // The watchdog timer is not owned by withConnection's cleanup; clear it.
      if (conn.sseWatchdogTimer) clearInterval(conn.sseWatchdogTimer);
    });
  });
});

describe('replacement sessions own their transport', () => {
  const local = (overrides: Partial<ServerConnection> = {}) =>
    makeConnection({ serverId: LOCAL_SERVER_ID, sessionToken: 'revoked-token', sessionId: 'old-session', sequence: 4, realtimeCursor: 9,
      eventSource: { close: () => {} } as unknown as ServerConnection['eventSource'], lastFrameTs: Date.now(), ...overrides });
  afterEach(() => { useAuthStore.setState({ token: null } as never); vi.restoreAllMocks(); });

  it('drops a stream opened with a revoked credential and forgets its resume point', async () => {
    useAuthStore.setState({ token: 'replacement-token' } as never);
    const conn = local();
    const replaced = vi.spyOn(manager, 'connectRealtime').mockImplementation(() => {});
    await withConnection(conn, async () => { await manager.connectLocalInternal(); });
    expect(replaced).toHaveBeenCalledWith(conn);
    expect(conn.sessionId).toBeNull(); expect(conn.sequence).toBeNull(); expect(conn.realtimeCursor).toBeNull();
  });

  it('keeps a healthy stream when the same session refreshed its access token', async () => {
    useAuthStore.setState({ token: 'same-token' } as never);
    const conn = local({ sessionToken: 'same-token' });
    const replaced = vi.spyOn(manager, 'connectRealtime').mockImplementation(() => {});
    await withConnection(conn, async () => { await manager.connectLocalInternal(); });
    expect(replaced).not.toHaveBeenCalled();
    expect(conn.sessionId).toBe('old-session'); expect(conn.realtimeCursor).toBe(9);
  });
});
