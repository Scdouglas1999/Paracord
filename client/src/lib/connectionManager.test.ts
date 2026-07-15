import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayEvents } from '../gateway/events';
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

      // Three silent watchdog ticks (no intervening frame) -> stale.
      vi.advanceTimersByTime(30_000 * 3);

      expect(reconnectSpy).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(conn.eventSource).toBeNull();
      expect(conn.connected).toBe(false);
      expect(conn.connectionLatency).toBe(42);
      expect(conn.sseWatchdogTimer).toBeNull();
    });
  });

  it('resets its miss counter whenever a frame keeps the stream alive', () => {
    const es = { close: vi.fn() } as unknown as EventSource;
    const conn = makeConnection({ eventSource: es, connected: true });

    withConnection(conn, () => {
      manager.startSseWatchdog(conn, es);
      // Two silent ticks accumulate misses...
      vi.advanceTimersByTime(30_000 * 2);
      expect(conn.missedAcks).toBe(2);
      expect(reconnectSpy).not.toHaveBeenCalled();

      // ...a live frame resets the counter, so the stream survives.
      conn.lastFrameTs = Date.now();
      conn.missedAcks = 0;
      vi.advanceTimersByTime(30_000 * 2);
      expect(reconnectSpy).not.toHaveBeenCalled();

      // The watchdog timer is not owned by withConnection's cleanup; clear it.
      if (conn.sseWatchdogTimer) clearInterval(conn.sseWatchdogTimer);
    });
  });
});
