import { describe, expect, it, vi } from 'vitest';
import { GatewayEvents } from '../gateway/events';
import { connectionManager, type ServerConnection } from './connectionManager';

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
    sequence: 7,
    sessionId: 'session-before',
    realtimeCursor: null,
    reconnectAttempts: 4,
    reconnectTimer: null,
    allowReconnect: true,
    connected: true,
    connecting: false,
    lastHeartbeatSent: 0,
    missedAcks: 0,
    connectionLatency: 0,
    pendingMessages: [],
    ...overrides,
  };
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
    const manager = connectionManager as unknown as {
      connections: Map<string, ServerConnection>;
      handleDispatch: (conn: ServerConnection, event: string, data: unknown) => void;
    };
    manager.connections.set(conn.serverId, conn);

    try {
      manager.handleDispatch(conn, GatewayEvents.RESUMED, { session_id: 'session-after' });
    } finally {
      manager.connections.delete(conn.serverId);
    }

    expect(conn.sessionId).toBe('session-after');
    expect(conn.reconnectAttempts).toBe(0);
    expect(conn.pendingMessages).toEqual([]);
    expect(sent.map((payload) => JSON.parse(payload))).toEqual([
      { op: 3, d: { status: 'online' } },
      { op: 4, d: { guild_id: '1', channel_id: '2' } },
    ]);
  });
});
