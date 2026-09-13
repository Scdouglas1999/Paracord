import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchGatewayEvent } from '../gateway/dispatch';
import { useServerListStore } from '../stores/serverListStore';
import { useAuthStore } from '../stores/authStore';
import type { GatewayPayload, User } from '../types';
import { connectionManager, type ServerConnection } from './connectionManager';
import { isTauri } from './tauriEnv';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { subscribeServerDisconnect } from './serverDisconnect';
import { pauseAccountMessagingForRecovery } from './messages/accountMessagingRuntime';
import { acceptDatabaseHistoryEpoch, clearDatabaseHistoryMemory, getDatabaseHistoryEpoch, requestHistoryReconciliation } from './databaseHistory';

vi.mock('../gateway/dispatch', () => ({ dispatchGatewayEvent: vi.fn() }));
vi.mock('./messages/accountMessagingRuntime', () => ({ pauseAccountMessagingForRecovery: vi.fn() }));
vi.mock('./desktopDiagnostics', () => ({ logVoiceDiagnostic: vi.fn() }));
vi.mock('./tauriEnv', () => ({ isTauri: vi.fn(() => false) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

type Frame = GatewayPayload & { event_id?: number };
type Internals = {
  connections: Map<string, ServerConnection>;
  offline: boolean;
  connectGateway(conn: ServerConnection): void;
  connectRealtimeSse(conn: ServerConnection): void;
  connectRealtime(conn: ServerConnection): void;
  cleanupConnection(conn: ServerConnection): void;
  syncUiConnectionStatus(): void;
};
const manager = connectionManager as unknown as Internals;
const scope = { serverId: 'delivery-test', userId: '42' };
const epoch = '7257b8f7-610e-4a8b-a20c-5a94a7b98428';
const restored = '31349d45-0b51-4c83-b41b-49ac76d648ce';
const dispatch = vi.mocked(dispatchGatewayEvent);
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(readonly url: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(payload: Frame) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  error() { this.onerror?.(); }
}
class Stream {
  static instances: Stream[] = [];
  static onConstruct: (() => void) | undefined;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { Stream.instances.push(this); Stream.onConstruct?.(); }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  frame(payload: Frame) { this.listeners.get('gateway')?.(new MessageEvent('gateway', { data: JSON.stringify(payload) })); }
  error() { this.onerror?.(new Event('error')); }
}
function makeConnection(): ServerConnection {
  const post = vi.fn(async (url: string) => url.endsWith('/session')
    ? { data: { session_id: 'session-before', cursor: 900 } }
    : { data: { ticket: 'private-ticket' } });
  return {
    serverId: scope.serverId, accountId: scope.userId, historyEpoch: epoch,
    serverUrl: 'http://localhost:8090', apiClient: { post } as unknown as ServerConnection['apiClient'],
    ws: null, eventSource: null, streamUrl: null, heartbeatTimer: null, heartbeatInterval: null,
    sseWatchdogTimer: null, lastFrameTs: 0, sequence: 10, realtimeCursor: 20,
    sessionId: 'session-before', reconnectAttempts: 0, reconnectTimer: null,
    allowReconnect: true, connected: false, connecting: false, lastHeartbeatSentAtMs: 0,
    missedAcks: 0, connectionLatency: 0, pendingMessages: [],
  };
}
function message(s = 11, event_id = 21, id = 'one'): Frame {
  return { op: 0, t: 'MESSAGE_CREATE', s, event_id, d: { id, e2ee: { ciphertext: 'secret-ciphertext' } } };
}
function lifecycle(t: 'READY' | 'RESUMED', s = 10, event_id = 20, history = epoch): Frame {
  return { op: 0, t, s, event_id, d: { user: { id: scope.userId }, session_id: 'session-before', database_history_epoch: history } };
}
async function start(conn: ServerConnection, kind: 'ws' | 'sse'): Promise<Socket | Stream> {
  if (kind === 'ws') manager.connectGateway(conn); else manager.connectRealtimeSse(conn);
  await settle();
  const transport = kind === 'ws' ? Socket.instances.at(-1)! : Stream.instances.at(-1)!;
  transport.open(); return transport;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('EventSource', Stream);
  Socket.instances = []; Stream.instances = []; Stream.onConstruct = undefined;
  dispatch.mockReset(); vi.mocked(isTauri).mockReturnValue(false); vi.mocked(invoke).mockReset(); vi.mocked(listen).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(manager, 'syncUiConnectionStatus').mockImplementation(() => {});
  manager.offline = false;
  localStorage.clear(); clearDatabaseHistoryMemory();
  useServerListStore.setState({ servers: [{ id: scope.serverId, name: 'Delivery test', url: 'http://localhost:8090', connected: true, token: 'token', userId: '42', user: { id: '42', username: 'owner' } as User }] });
  acceptDatabaseHistoryEpoch(scope, epoch);
});
afterEach(() => {
  for (const id of manager.connections.keys()) connectionManager.disconnectServer(id);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
for (const kind of ['ws', 'sse'] as const) describe(`${kind} durable dispatch ownership`, () => {
  function reconnectAsTestTransport() {
    vi.spyOn(manager, 'connectRealtime').mockImplementation(conn => {
      if (kind === 'ws') manager.connectGateway(conn); else manager.connectRealtimeSse(conn);
    });
  }
  it('preserves immediate synchronous delivery and both checkpoints', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const transport = await start(conn, kind); transport.frame(message());
    expect(dispatch).toHaveBeenCalledOnce();
    expect([conn.sequence, conn.realtimeCursor]).toEqual([11, 21]);
  });
  it('orders durable commits while liveness controls and heartbeat remain prompt', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const first = deferred(); const second = deferred();
    dispatch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const transport = await start(conn, kind);
    transport.frame(message()); transport.frame(message(12, 22, 'two'));
    expect(dispatch).toHaveBeenCalledOnce();
    expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
    conn.missedAcks = 2; transport.frame({ op: 11, d: null, s: 99, event_id: 99 });
    expect(conn.missedAcks).toBe(0);
    expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
    if (transport instanceof Socket) {
      transport.frame({ op: 10, d: { heartbeat_interval: 1000 } }); vi.advanceTimersByTime(1000);
      expect(transport.send.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual({ op: 1, d: 10 });
    }
    first.resolve(); await settle();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect([conn.sequence, conn.realtimeCursor]).toEqual([11, 21]);
    second.resolve(); await settle(); expect([conn.sequence, conn.realtimeCursor]).toEqual([12, 22]);
  });
  it('replays after rejection from the last completed checkpoint and discards followers', async () => {
    reconnectAsTestTransport();
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const write = deferred(); dispatch.mockReturnValueOnce(write.promise);
    const transport = await start(conn, kind);
    transport.frame(message()); transport.frame(message(12, 22, 'follower'));
    write.reject(new Error('private-ticket secret-ciphertext account-key')); await settle();
    expect(transport.close).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledOnce();
    expect([conn.sequence, conn.realtimeCursor, conn.sessionId]).toEqual([10, 20, 'session-before']);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/private-ticket|secret-ciphertext|account-key/);
    await vi.advanceTimersByTimeAsync(1000); await settle();
    const replacement = kind === 'ws' ? Socket.instances.at(-1)! : Stream.instances.at(-1)!;
    expect(replacement).not.toBe(transport); replacement.open();
    if (replacement instanceof Socket) {
      replacement.frame({ op: 10, d: { heartbeat_interval: 60_000 } });
      expect(JSON.parse(replacement.send.mock.calls[0][0])).toEqual({ op: 6, d: { token: 'token', session_id: 'session-before', seq: 10 } });
      replacement.frame(lifecycle('RESUMED', 99)); expect(conn.sequence).toBe(10);
    } else {
      expect(new URL(replacement.url).searchParams.get('cursor')).toBe('20'); replacement.frame(lifecycle('READY'));
    }
    expect(conn.reconnectAttempts).toBeGreaterThan(0);
    dispatch.mockReturnValueOnce(Promise.resolve());
    replacement.frame(message()); replacement.frame(message(12, 22, 'follower')); await settle();
    expect([conn.sequence, conn.realtimeCursor]).toEqual([12, 22]); expect(conn.reconnectAttempts).toBe(0);
  });
  it.each(['resolve', 'reject'] as const)('ignores late %s and duplicate callbacks from replaced transports', async outcome => {
    reconnectAsTestTransport();
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const write = deferred(); dispatch.mockReturnValueOnce(write.promise);
    const old = await start(conn, kind); old.frame(message()); old.frame(message(12, 22, 'discarded')); old.error();
    await vi.advanceTimersByTimeAsync(0); await settle();
    const replacement = kind === 'ws' ? Socket.instances.at(-1)! : Stream.instances.at(-1)!;
    replacement.open(); replacement.frame(message(30, 40, 'current'));
    const attempts = conn.reconnectAttempts;
    if (outcome === 'resolve') write.resolve(); else write.reject(new Error('late'));
    await settle(); old.frame(message(99, 99, 'duplicate')); old.error();
    expect([conn.sequence, conn.realtimeCursor]).toEqual([30, 40]);
    expect(dispatch).toHaveBeenCalledTimes(2); expect(replacement.close).not.toHaveBeenCalled();
    expect(conn.reconnectAttempts).toBe(attempts); expect(conn.reconnectTimer).toBeNull();
  });
  it('ignores an account switch even when the connection object is reused', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const write = deferred(); dispatch.mockReturnValueOnce(write.promise);
    const transport = await start(conn, kind); transport.frame(message()); transport.frame(message(12, 22, 'queued'));
    useServerListStore.setState(state => ({ servers: state.servers.map(server => ({ ...server, userId: '84', user: { id: '84' } as User })) }));
    write.resolve(); await settle(); transport.frame(message(30, 40, 'wrong-account'));
    expect(dispatch).toHaveBeenCalledOnce(); expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
  });
  it('does not swallow synchronous persistence throws or invalid checkpoint frames', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dispatch.mockImplementationOnce(() => { throw new Error('private vault failure'); });
    const transport = await start(conn, kind); transport.frame(message());
    expect(warn).not.toHaveBeenCalled(); expect(transport.close).toHaveBeenCalledOnce();
    expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
  });
  it('rejects an invalid dispatch checkpoint before durable work begins', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const transport = await start(conn, kind); transport.frame(message(-1, 21));
    expect(dispatch).not.toHaveBeenCalled(); expect(transport.close).toHaveBeenCalledOnce();
    expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
  });
  it('isolates old account completion after logout and same-server login', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const write = deferred(); dispatch.mockReturnValueOnce(write.promise);
    const old = await start(conn, kind); old.frame(message()); connectionManager.disconnectServer(conn.serverId);
    useServerListStore.setState(state => ({ servers: state.servers.map(server => ({ ...server, userId: '84', user: { id: '84' } as User })) }));
    acceptDatabaseHistoryEpoch({ ...scope, userId: '84' }, epoch);
    const current = { ...makeConnection(), accountId: '84' }; manager.connections.set(current.serverId, current);
    const replacement = await start(current, kind); replacement.frame(message(30, 40, 'new-account'));
    write.resolve(); await settle();
    expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
    expect([current.sequence, current.realtimeCursor]).toEqual([30, 40]); expect(replacement.close).not.toHaveBeenCalled();
  });
  it.each(['count', 'bytes'] as const)('bounds retained queue %s without acknowledging overflow', async bound => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const write = deferred(); dispatch.mockReturnValueOnce(write.promise);
    const transport = await start(conn, kind); transport.frame(message());
    if (bound === 'count') {
      for (let i = 0; i < 999; i++) transport.frame(message(12 + i, 22 + i, `queued-${i}`));
      expect(transport.close).not.toHaveBeenCalled(); transport.frame(message(2000, 2000, 'overflow'));
    } else transport.frame({ ...message(12, 22), d: { ciphertext: 'x'.repeat(4 * 1024 * 1024) } });
    expect(transport.close).toHaveBeenCalledOnce(); write.resolve(); await settle();
    expect(dispatch).toHaveBeenCalledOnce(); expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
    expect(conn.reconnectTimer).not.toBeNull();
  });
  it('invalidates pending storage immediately on history reconciliation', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const write = deferred(); dispatch.mockReturnValueOnce(write.promise);
    const transport = await start(conn, kind); transport.frame(message()); transport.frame(message(12, 22, 'old-history'));
    requestHistoryReconciliation(scope); write.resolve(); await settle();
    expect(dispatch).toHaveBeenCalledOnce(); expect([conn.sequence, conn.realtimeCursor, conn.sessionId]).toEqual([null, null, null]);
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it('resets before changed READY and discards replay following changed RESUMED', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const transport = await start(conn, kind);
    dispatch.mockImplementationOnce(() => {
      expect([conn.sequence, conn.realtimeCursor]).toEqual([null, null]); expect(getDatabaseHistoryEpoch(scope)).toBe(restored);
    });
    transport.frame(lifecycle('READY', 2, 3, restored)); expect([conn.sequence, conn.realtimeCursor]).toEqual([2, 3]);
    transport.frame(lifecycle('RESUMED', 99, 99, epoch)); transport.frame(message(100, 100, 'wrong-history'));
    expect([conn.sequence, conn.realtimeCursor, conn.sessionId]).toEqual([null, null, null]);
    expect(dispatch).toHaveBeenCalledOnce(); expect(transport.close).toHaveBeenCalledOnce();
  });
  it('reports a replaced session as one, and does not count it against backoff', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    reconnectAsTestTransport();
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    conn.sessionToken = 'token';
    const transport = await start(conn, kind);
    transport.frame(lifecycle('READY'));
    // Attaching a device identity mints a new bearer token and revokes the old
    // session; the dispatch in flight is aborted by that, not by storage.
    useServerListStore.setState(state => ({ servers: state.servers.map(server => ({ ...server, token: 'attached-token' })) }));
    dispatch.mockReturnValueOnce(Promise.reject(new Error('operation aborted')));
    transport.frame(message()); await settle();

    expect(console.error).not.toHaveBeenCalled();
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({ reason: 'session replaced' });

    // No durable failure was recorded, so the replacement session's READY
    // clears the backoff instead of carrying a penalty this connection did not
    // earn. A real persistence failure holds its count through READY — that is
    // the test directly below.
    await vi.advanceTimersByTimeAsync(1000); await settle();
    const next = kind === 'ws' ? Socket.instances.at(-1)! : Stream.instances.at(-1)!;
    expect(next).not.toBe(transport);
    next.open(); next.frame(lifecycle('READY')); await settle();
    expect(conn.reconnectAttempts).toBe(0);
  });
  it('retains increasing persistence failure backoff through successful READY', async () => {
    reconnectAsTestTransport();
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    let transport = await start(conn, kind);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      transport.frame(lifecycle('READY')); dispatch.mockReturnValueOnce(Promise.reject(new Error('quota')));
      transport.frame(message()); await settle(); const old = transport;
      await vi.advanceTimersByTimeAsync(delay - 1); await settle();
      expect(kind === 'ws' ? Socket.instances.at(-1) : Stream.instances.at(-1)).toBe(old);
      await vi.advanceTimersByTimeAsync(1); await settle();
      transport = kind === 'ws' ? Socket.instances.at(-1)! : Stream.instances.at(-1)!;
      expect(transport).not.toBe(old); transport.open(); expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
    }
  });
});
describe('SSE bootstrap ownership', () => {
  it.each(['session', 'ticket'] as const)('ignores late %s responses on the same connection object', async stage => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const pending = deferred<{ data: Record<string, unknown> }>(); const post = vi.mocked(conn.apiClient.post);
    if (stage === 'session') post.mockImplementationOnce(() => pending.promise);
    else {
      post.mockResolvedValueOnce({ data: { session_id: 'old-bootstrap', cursor: 999 } });
      post.mockImplementationOnce(() => pending.promise);
    }
    manager.connectRealtimeSse(conn); await settle();
    expect([conn.sessionId, conn.sequence, conn.realtimeCursor]).toEqual(['session-before', 10, 20]);
    manager.cleanupConnection(conn); conn.connecting = false;
    const current = await start(conn, 'sse'); current.frame(lifecycle('READY', 30, 40)); const calls = post.mock.calls.length;
    pending.resolve({ data: stage === 'session' ? { session_id: 'stale-session', cursor: 999 } : { ticket: 'stale-ticket' } }); await settle();
    expect(post).toHaveBeenCalledTimes(calls); expect(Stream.instances).toHaveLength(1);
    expect([conn.sequence, conn.realtimeCursor, conn.sessionId]).toEqual([30, 40, 'session-before']);
    expect(conn.eventSource).toBe(current); expect(current.close).not.toHaveBeenCalled();
  });
  it('ignores late setup rejection without scheduling replacement recovery', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const pending = deferred<{ data: Record<string, unknown> }>(); vi.mocked(conn.apiClient.post).mockImplementationOnce(() => pending.promise);
    manager.connectRealtimeSse(conn); await settle(); manager.cleanupConnection(conn); conn.connecting = false;
    const current = await start(conn, 'sse'); pending.reject(new Error('stale request')); await settle();
    expect(conn.eventSource).toBe(current); expect(conn.connected).toBe(true);
    expect(conn.reconnectTimer).toBeNull(); expect(conn.reconnectAttempts).toBe(0);
  });
  it('closes EventSource returned after setup ownership was replaced', async () => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    Stream.onConstruct = () => {
      Stream.onConstruct = undefined; manager.cleanupConnection(conn); conn.connecting = false; manager.connectRealtimeSse(conn);
    };
    manager.connectRealtimeSse(conn); await settle();
    expect(Stream.instances).toHaveLength(2); expect(Stream.instances[0].close).toHaveBeenCalledOnce();
    expect(Stream.instances[1].close).not.toHaveBeenCalled(); expect(conn.eventSource).toBe(Stream.instances[1]);
    expect([conn.sequence, conn.realtimeCursor]).toEqual([10, 20]);
  });
  it('uses bootstrap head only as input until READY and retains completed resync head', async () => {
    const conn = { ...makeConnection(), sequence: null, realtimeCursor: null, sessionId: null };
    manager.connections.set(conn.serverId, conn); const transport = await start(conn, 'sse') as Stream;
    expect(new URL(transport.url).searchParams.get('cursor')).toBe('900');
    expect([conn.sequence, conn.realtimeCursor, conn.sessionId]).toEqual([null, null, null]);
    transport.frame(lifecycle('READY', 900, 900));
    expect([conn.sequence, conn.realtimeCursor, conn.sessionId]).toEqual([900, 900, 'session-before']);
    transport.frame({ op: 9, d: { reason: 'replay_gap', resumable: false } });
    expect([conn.sequence, conn.realtimeCursor, conn.sessionId]).toEqual([900, 900, null]); expect(transport.close).toHaveBeenCalledOnce();
  });
});


describe('native SSE startup ownership', () => {
  it('receives early READY before start resolves and fences a late native completion', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    const started = deferred(); const unlisten = vi.fn();
    let emit: ((event: { payload: { streamId: string; kind: string; event?: string; data?: string } }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (_event, callback) => {
      emit = callback as typeof emit;
      return unlisten;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== 'start_native_sse_stream') return;
      const streamId = (args as { streamId: string }).streamId;
      emit?.({ payload: { streamId, kind: 'open' } });
      emit?.({ payload: { streamId, kind: 'message', event: 'gateway', data: JSON.stringify(lifecycle('READY', 30, 40)) } });
      await started.promise;
    });
    manager.connectRealtimeSse(conn);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect([conn.sequence, conn.realtimeCursor]).toEqual([30, 40]);
    expect(conn.connected).toBe(true);
    const native = conn.eventSource;
    connectionManager.disconnectServer(conn.serverId);
    vi.mocked(isTauri).mockReturnValue(false);
    const current = makeConnection(); manager.connections.set(current.serverId, current);
    const replacement = await start(current, 'sse'); replacement.frame(message(50, 60, 'current'));
    started.resolve(); await settle();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'stop_native_sse_stream')).toHaveLength(2);
    expect(current.eventSource).toBe(replacement); expect(current.eventSource).not.toBe(native);
    expect([current.sequence, current.realtimeCursor]).toEqual([50, 60]);
    expect(replacement.close).not.toHaveBeenCalled();
  });
});


for (const kind of ['ws', 'sse'] as const) describe(`${kind} token-only account hydration`, () => {
  it('waits for the verified account before creating its transport lane', async () => {
    useAuthStore.setState({ token: 'reload-token', user: null });
    const conn = { ...makeConnection(), serverId: '__local__', accountId: undefined };
    manager.connections.set(conn.serverId, conn);
    if (kind === 'ws') manager.connectGateway(conn); else manager.connectRealtimeSse(conn);
    await settle();
    expect(conn.connecting).toBe(false);
    expect(conn.apiClient.post).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(0); expect(Stream.instances).toHaveLength(0);
    acceptDatabaseHistoryEpoch({ serverId: '__local__', userId: '42' }, epoch);
    useAuthStore.setState({ user: { id: '42', username: 'owner' } as User });
    await settle();
    const transport = kind === 'ws' ? Socket.instances.at(-1)! : Stream.instances.at(-1)!;
    transport.open(); transport.frame(lifecycle('READY')); transport.frame(message());
    expect(conn.connected).toBe(true); expect(conn.connecting).toBe(false);
    expect([conn.sequence, conn.realtimeCursor]).toEqual([11, 21]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it('does not adopt later hydration after the waiting login or connection is replaced', async () => {
    useAuthStore.setState({ token: 'old-token', user: null });
    const conn = { ...makeConnection(), serverId: '__local__', accountId: undefined };
    manager.connections.set(conn.serverId, conn);
    if (kind === 'ws') manager.connectGateway(conn); else manager.connectRealtimeSse(conn);
    useAuthStore.setState({ token: 'new-token' });
    useAuthStore.setState({ user: { id: '84', username: 'new-owner' } as User });
    await settle();
    expect(Socket.instances).toHaveLength(0); expect(Stream.instances).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled(); expect(conn.connecting).toBe(false);
  });
});

describe('explicit server disconnect ownership', () => {
  it('notifies the owner even when no transport connection exists', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeServerDisconnect(listener);
    try {
      connectionManager.disconnectServer('not-connected');
      expect(listener).toHaveBeenCalledExactlyOnceWith('not-connected');
    } finally { unsubscribe(); }
  });

  it('keeps transient transport cleanup independent of the call owner', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeServerDisconnect(listener);
    try {
      const conn = makeConnection();
      manager.cleanupConnection(conn);
      expect(listener).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});

describe('owned messaging recovery pause', () => {
  it.each(['ws', 'sse'] as const)('pauses %s delivery before bootstrap and on transport loss', async kind => {
    const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
    vi.mocked(pauseAccountMessagingForRecovery).mockClear();
    const starting = start(conn, kind);
    expect(pauseAccountMessagingForRecovery).toHaveBeenCalledExactlyOnceWith(scope);
    const transport = await starting;
    vi.mocked(pauseAccountMessagingForRecovery).mockClear();
    if (transport instanceof Socket) transport.close(); else transport.error();
    expect(pauseAccountMessagingForRecovery).toHaveBeenCalledExactlyOnceWith(scope);
  });

  it('never pauses a replacement connection or a foreign verified owner during old cleanup', () => {
    const old = makeConnection(); const replacement = makeConnection();
    manager.connections.set(scope.serverId, replacement);
    vi.mocked(pauseAccountMessagingForRecovery).mockClear();
    manager.cleanupConnection(old);
    expect(pauseAccountMessagingForRecovery).not.toHaveBeenCalled();
    useServerListStore.setState({ servers: [{ id: scope.serverId, url: old.serverUrl, token: 'foreign', userId: '99', user: { id: '99' } as User }] as never });
    manager.cleanupConnection(replacement);
    expect(pauseAccountMessagingForRecovery).not.toHaveBeenCalled();
  });
});

for (const transport of ['ws', 'sse'] as const) it(`${transport} voice commands carry the call receipt and omit it for legacy callers`, async () => {
  const conn = makeConnection(); manager.connections.set(conn.serverId, conn);
  const internal = connectionManager as unknown as { useRealtimeV2: boolean };
  const original = internal.useRealtimeV2;
  internal.useRealtimeV2 = transport === 'sse';
  try {
    const socket = new Socket('ws://test'); socket.readyState = Socket.OPEN;
    conn.ws = socket as unknown as WebSocket; conn.connected = true;
    connectionManager.updateVoiceState(conn.serverId, '70', '71', true, false, true, 'call-receipt');
    connectionManager.updateVoiceState(conn.serverId, '70', null, false, false);
    await settle();
    const payloads = transport === 'sse'
      ? vi.mocked(conn.apiClient.post).mock.calls.map(call => (call[1] as { payload: unknown }).payload)
      : socket.send.mock.calls.map(call => JSON.parse(call[0] as string).d);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ session_id: 'call-receipt', channel_id: '71', self_mute: true });
    expect(payloads[1]).not.toHaveProperty('session_id');
  } finally { internal.useRealtimeV2 = original; }
});
