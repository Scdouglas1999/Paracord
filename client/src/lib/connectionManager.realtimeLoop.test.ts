// The realtime connection has to be able to sit still.
//
// Against a real server the 3.0 release candidate never held one: the client
// created a realtime session, opened a stream, and tore it down again on a
// fixed cycle, forever — refetching every guild's channels and members each
// time. Two independent defects produced that, and these are the tests for
// both.
//
//  1. The liveness watchdog counted ticks instead of measuring silence. The
//     server's idle keepalive was an SSE comment, which no SSE consumer ever
//     surfaces, so a perfectly healthy idle stream looked dead after three
//     ticks and was replaced. (The server now heartbeats with a real op-11
//     frame; the watchdog now measures the real gap since the last frame.)
//  2. `connectAll()` was re-entrant. `useGateway` re-runs when a server's token
//     changes, and a first login changes it twice in the same millisecond, so
//     two runs each created a connection for the same server — two sessions,
//     two streams, one of them orphaned with nothing left to close it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useServerListStore } from '../stores/serverListStore';
import { useAuthStore } from '../stores/authStore';
import type { GatewayPayload, User } from '../types';
import { connectionManager, type ServerConnection } from './connectionManager';
import { isTauri } from './tauriEnv';
import { createApiClient } from '../api/client';
import { acceptDatabaseHistoryEpoch, clearDatabaseHistoryMemory } from './databaseHistory';

vi.mock('../gateway/dispatch', () => ({ dispatchGatewayEvent: vi.fn() }));
vi.mock('./messages/accountMessagingRuntime', () => ({ pauseAccountMessagingForRecovery: vi.fn() }));
vi.mock('./desktopDiagnostics', () => ({ logVoiceDiagnostic: vi.fn() }));
vi.mock('./tauriEnv', () => ({ isTauri: vi.fn(() => false) }));
vi.mock('../api/client', () => ({ createApiClient: vi.fn() }));

type Frame = GatewayPayload & { event_id?: number };
type Internals = {
  connections: Map<string, ServerConnection>;
  offline: boolean;
  connectRealtimeSse(conn: ServerConnection): void;
  connectRealtime(conn: ServerConnection): void;
  syncUiConnectionStatus(): void;
};
const manager = connectionManager as unknown as Internals;
const scope = { serverId: 'loop-test', userId: '42' };
const epoch = '7257b8f7-610e-4a8b-a20c-5a94a7b98428';

/** The server's idle heartbeat cadence (SSE_KEEPALIVE_INTERVAL, server side). */
const SERVER_HEARTBEAT_MS = 15_000;
/** The keepalive frame the server sends on an idle stream, verbatim. */
const HEARTBEAT: Frame = { op: 11, d: null } as unknown as Frame;

async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

class Stream {
  static instances: Stream[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { Stream.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  frame(payload: Frame) {
    this.listeners.get('gateway')?.(new MessageEvent('gateway', { data: JSON.stringify(payload) }));
  }
}

/** Every POST the client made, so a test can count realtime sessions. */
let posts: string[] = [];

/** A complete `GET /users/@me` body, so the real response contract accepts it. */
const currentUser = {
  avatar_hash: null, banner_hash: null, accent_color: null, bio: null, bot: false,
  created_at: '2026-01-01T00:00:00Z', discriminator: 0, display_name: null,
  email: 'owner@example.test', email_verified: true, flags: 0,
  has_public_key: false, id: scope.userId, linked_accounts: [], pronouns: null,
  public_key: null, system: false, username: 'owner',
};

function fakeApiClient(): ServerConnection['apiClient'] {
  const post = vi.fn(async (url: string) => {
    posts.push(url);
    return url.endsWith('/session')
      ? { data: { session_id: 'session-one', cursor: 0 } }
      : { data: { ticket: 'private-ticket' } };
  });
  const get = vi.fn(async () => ({ data: currentUser }));
  return { post, get } as unknown as ServerConnection['apiClient'];
}

function makeConnection(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    serverId: scope.serverId, accountId: scope.userId, historyEpoch: epoch,
    serverUrl: 'http://localhost:8090', apiClient: fakeApiClient(),
    ws: null, eventSource: null, streamUrl: null, heartbeatTimer: null, heartbeatInterval: null,
    sseWatchdogTimer: null, lastFrameTs: 0, sequence: null, realtimeCursor: null,
    sessionId: null, reconnectAttempts: 0, reconnectTimer: null,
    allowReconnect: true, connected: false, connecting: false, lastHeartbeatSentAtMs: 0,
    missedAcks: 0, connectionLatency: 0, pendingMessages: [],
    ...overrides,
  };
}

/** Start a stream for `conn` and bring it up, as the real setup path does. */
async function open(conn: ServerConnection): Promise<Stream> {
  manager.connectRealtimeSse(conn);
  await settle();
  const stream = Stream.instances.at(-1)!;
  stream.open();
  return stream;
}

/** Advance `ms` of fake time, letting each timer's async work settle. */
async function advance(ms: number): Promise<void> {
  const step = 1_000;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Stream);
  Stream.instances = [];
  posts = [];
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(createApiClient).mockImplementation(() => fakeApiClient() as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(manager, 'syncUiConnectionStatus').mockImplementation(() => {});
  manager.offline = false;
  localStorage.clear();
  clearDatabaseHistoryMemory();
  useAuthStore.setState({ token: null });
  useServerListStore.setState({
    hydrated: true,
    tokensHydrated: true,
    servers: [{
      id: scope.serverId, name: 'Loop test', url: 'http://localhost:8090',
      connected: true, token: 'token', userId: '42',
      user: { id: '42', username: 'owner' } as User,
    }],
  });
  acceptDatabaseHistoryEpoch(scope, epoch);
});

afterEach(() => {
  for (const id of [...manager.connections.keys()]) connectionManager.disconnectServer(id);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('an idle realtime stream', () => {
  it('is held for a quarter of an hour when the server only heartbeats', async () => {
    const conn = makeConnection();
    manager.connections.set(conn.serverId, conn);
    const stream = await open(conn);
    expect(posts.filter((url) => url.endsWith('/rt/session'))).toHaveLength(1);

    // Nothing happens in this account's world. The server's only traffic is the
    // idle heartbeat, every 15 seconds — which is exactly the case the release
    // candidate could not survive.
    for (let elapsed = 0; elapsed < 15 * 60_000; elapsed += SERVER_HEARTBEAT_MS) {
      await advance(SERVER_HEARTBEAT_MS);
      stream.frame(HEARTBEAT);
    }

    expect(
      posts.filter((url) => url.endsWith('/rt/session')),
      'a heartbeating stream must never be replaced',
    ).toHaveLength(1);
    expect(Stream.instances).toHaveLength(1);
    expect(conn.connected).toBe(true);
    expect(stream.close).not.toHaveBeenCalled();
  });

  it('forgives the reconnect backoff once the stream has carried traffic', async () => {
    // A quiet account delivers no durable event, and only a durable event used
    // to clear the backoff — so a client that had once fallen behind stayed at
    // the 30s cap for the rest of the session, reconnecting on that cadence.
    const conn = makeConnection({ reconnectAttempts: 9 });
    manager.connections.set(conn.serverId, conn);
    const stream = await open(conn);
    for (let elapsed = 0; elapsed < 60_000; elapsed += SERVER_HEARTBEAT_MS) {
      await advance(SERVER_HEARTBEAT_MS);
      stream.frame(HEARTBEAT);
    }
    expect(conn.reconnectAttempts).toBe(0);
  });

  it('is replaced once, not repeatedly, when it genuinely goes silent', async () => {
    const conn = makeConnection();
    manager.connections.set(conn.serverId, conn);
    const first = await open(conn);

    // No heartbeat, no events: the stream really is dead.
    await advance(75_000);
    expect(first.close).toHaveBeenCalled();
    expect(Stream.instances.length).toBe(2);

    // The replacement comes up and heartbeats; it must then be left alone.
    const second = Stream.instances.at(-1)!;
    second.open();
    for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += SERVER_HEARTBEAT_MS) {
      await advance(SERVER_HEARTBEAT_MS);
      second.frame(HEARTBEAT);
    }
    expect(Stream.instances).toHaveLength(2);
  });
});

describe('the one-session invariant', () => {
  it('never runs two reconciliations at once', async () => {
    // `useGateway` re-runs whenever a server's token changes, and a first login
    // changes it twice within the same millisecond — so connectAll() is called
    // twice, concurrently, before either run has decided anything. Re-entrant,
    // the two runs each read a different snapshot of the server list and each
    // reconcile against it: one creates a connection the other's closing sweep
    // then tears down, or two connections to the same host survive and race for
    // the same account. Whatever the outcome that day, it is not reproducible,
    // and the connection map is the wrong place to discover it. One at a time.
    let inside = 0;
    let overlapped = false;
    const sync = vi
      .spyOn(manager as unknown as { syncTrustedHosts(urls: string[]): Promise<void> }, 'syncTrustedHosts')
      .mockImplementation(async () => {
        inside += 1;
        if (inside > 1) overlapped = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        inside -= 1;
      });

    const both = Promise.all([connectionManager.connectAll(), connectionManager.connectAll()]);
    await vi.advanceTimersByTimeAsync(100);
    await both;
    await settle();

    expect(sync).toHaveBeenCalled();
    expect(overlapped, 'two connectAll() runs reconciled the connection map at once').toBe(false);
    expect(manager.connections.size).toBe(1);
    const sessions = posts.filter((url) => url.endsWith('/rt/session'));
    expect(sessions, `one server, one realtime session: ${JSON.stringify(posts)}`).toHaveLength(1);
    expect(Stream.instances.length).toBeLessThanOrEqual(1);
  });
});
