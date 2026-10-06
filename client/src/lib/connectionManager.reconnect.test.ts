// A saved server must come back by itself, or say why it cannot.
//
// The desktop app was found sitting on "This server is not available" after a
// relaunch, with the server healthy and a perfectly good refresh token on
// disk. The access token had expired while the app was closed (they last 15
// minutes), which is ordinary. What was not: session bootstrap had tried to
// refresh a few milliseconds earlier, before the desktop shell had verified the
// server's origin, and the shell refused the request before it left the
// machine. The refresh coordinator remembered that refusal for two seconds and
// handed it to the saved server's own refresh; its connect failed with the
// original 401, and nothing ever tried again.
//
// These drive the real connection manager and the real per-server API client
// (its 401 → refresh → retry interceptor) against a scripted server.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';

import type { GatewayPayload } from '../types';
import { loadValidators } from '../api/contractValidators';
import { refreshSharedSession } from '../api/client';
import { useAuthStore } from '../stores/authStore';
import { useServerConnectionStore } from '../stores/serverConnectionStore';
import { useServerListStore, type ServerEntry } from '../stores/serverListStore';
import { coordinateRefresh, HOME_REFRESH_SCOPE, resetRefreshCoordination } from './authRefreshCoordinator';
import { getRefreshToken, setAccessToken, setRefreshToken } from './authToken';
import { clearStoredServerUrl, setStoredServerUrl } from './config/apiBaseUrl';
import { connectionManager, type ServerConnection } from './connectionManager';
import { clearDatabaseHistoryMemory } from './databaseHistory';
import { isTauri } from './tauriEnv';

vi.mock('../gateway/dispatch', () => ({ dispatchGatewayEvent: vi.fn() }));
vi.mock('./messages/accountMessagingRuntime', () => ({ pauseAccountMessagingForRecovery: vi.fn() }));
vi.mock('./desktopDiagnostics', () => ({ logVoiceDiagnostic: vi.fn() }));
vi.mock('./tauriEnv', () => ({ isTauri: vi.fn(() => false) }));
vi.mock('./secureStorage', () => {
  const memory = new Map<string, string>();
  return {
    secureGet: vi.fn(async (key: string) => memory.get(key) ?? null),
    secureSet: vi.fn(async (key: string, value: string) => void memory.set(key, value)),
    secureDelete: vi.fn(async (key: string) => void memory.delete(key)),
    readStoredValueForMigration: vi.fn(async () => null),
  };
});
// Every API client (the home singleton, each saved server's, the probe) is built
// with this adapter: the scripted server below.
vi.mock('./tauriAxiosAdapter', () => ({
  getTauriAdapter: () => (config: InternalAxiosRequestConfig) => scripted(config),
  tauriAdapter: (config: InternalAxiosRequestConfig) => scripted(config),
}));

type Request = { method: string; origin: string; path: string; auth: string | null; body: Record<string, unknown> | null };
type Reply = { status: number; data?: unknown } | 'unreachable';

let requests: Request[] = [];
let answer: (request: Request) => Reply = () => 'unreachable';

async function scripted(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const url = new URL(axios.getUri(config));
  const header = config.headers?.Authorization ?? config.headers?.authorization;
  const request: Request = {
    method: (config.method ?? 'get').toUpperCase(),
    origin: url.origin,
    path: url.pathname,
    auth: typeof header === 'string' ? header.replace(/^Bearer /, '') : null,
    body: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : null,
  };
  requests.push(request);
  const reply = answer(request);
  if (reply === 'unreachable') throw new AxiosError('connect ECONNREFUSED', AxiosError.ERR_NETWORK, config, null);
  const response = { data: reply.data ?? {}, status: reply.status, statusText: '', headers: {}, config } as AxiosResponse;
  if (reply.status >= 400) {
    throw new AxiosError(`Request failed with status code ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
  }
  return response;
}

class Stream {
  static instances: Stream[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { Stream.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  frame(payload: GatewayPayload & { event_id?: number }) {
    this.listeners.get('gateway')?.(new MessageEvent('gateway', { data: JSON.stringify(payload) }));
  }
  fail() { this.readyState = 2; this.onerror?.(new Event('error')); }
}

const LAN = 'https://lan.example:8443';
const USER_ID = '360111917873762304';
const EPOCH = '7257b8f7-610e-4a8b-a20c-5a94a7b98428';
const currentUser = {
  avatar_hash: null, banner_hash: null, accent_color: null, bio: null, bot: false,
  created_at: '2026-01-01T00:00:00Z', discriminator: 0, display_name: null,
  email: 'owner@example.test', email_verified: true, flags: 0,
  has_public_key: false, id: USER_ID, linked_accounts: [], pronouns: null,
  public_key: null, system: false, username: 'owner',
};

type Internals = { connections: Map<string, ServerConnection>; offline: boolean };
const manager = connectionManager as unknown as Internals;

/**
 * A healthy server: `valid` names the access tokens it accepts and `rotations`
 * the refresh token it will rotate next (one use each, like the real one).
 */
function server(options: { valid: Set<string>; refresh: Map<string, { token: string; refresh: string }> }) {
  return (request: Request): Reply => {
    if (request.path === '/api/v1/auth/refresh') {
      const presented = String(request.body?.refresh_token ?? '');
      const next = options.refresh.get(presented);
      if (!next) return { status: 401, data: { code: 'UNAUTHORIZED', message: 'unauthorized' } };
      options.refresh.delete(presented);
      options.valid.add(next.token);
      return { status: 200, data: { token: next.token, refresh_token: next.refresh } };
    }
    if (!request.auth || !options.valid.has(request.auth)) return { status: 401, data: { code: 'UNAUTHORIZED', message: 'unauthorized' } };
    if (request.path === '/api/v1/users/@me') return { status: 200, data: currentUser };
    if (request.path === '/api/v2/rt/session') return { status: 200, data: { session_id: 'rt-session', cursor: 0 } };
    if (request.path === '/api/v1/stream/ticket') return { status: 200, data: { ticket: 'one-use' } };
    return { status: 200, data: {} };
  };
}

function entry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return { id: 's_lan', name: 'Lantern', url: LAN, token: 'access-expired', refreshToken: 'refresh-1', connected: false, ...overrides };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Advance fake time in steps, letting each timer's async work run. */
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) await vi.advanceTimersByTimeAsync(Math.min(250, ms - elapsed));
}

const phase = (id = 's_lan') => useServerConnectionStore.getState().servers[id] ?? null;
const refreshes = () => requests.filter((request) => request.path === '/api/v1/auth/refresh');

beforeAll(async () => {
  await loadValidators();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(isTauri).mockReturnValue(false);
  vi.stubGlobal('EventSource', Stream);
  Stream.instances = [];
  requests = [];
  answer = () => 'unreachable';
  manager.offline = false;
  localStorage.clear();
  clearStoredServerUrl();
  clearDatabaseHistoryMemory();
  resetRefreshCoordination();
  setAccessToken(null);
  setRefreshToken(null);
  useAuthStore.setState({ token: null, user: null });
  useServerConnectionStore.getState().reset();
  useServerListStore.setState({ hydrated: true, tokensHydrated: true, activeServerId: 's_lan', servers: [entry()] });
});

afterEach(() => {
  connectionManager.disconnectAll();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a saved server at launch', () => {
  it('refreshes an expired access token silently and connects', async () => {
    answer = server({ valid: new Set(), refresh: new Map([['refresh-1', { token: 'access-2', refresh: 'refresh-2' }]]) });

    await connectionManager.connectAll();
    await settle();

    const saved = useServerListStore.getState().getServer('s_lan');
    expect(saved?.token).toBe('access-2');
    expect(saved?.refreshToken).toBe('refresh-2');
    expect(refreshes()).toHaveLength(1);
    expect(Stream.instances).toHaveLength(1);
    expect(phase()?.phase).toBe('connecting');

    // Connected for the UI once READY has been applied.
    Stream.instances[0].open();
    Stream.instances[0].frame({ op: 0, t: 'READY', s: 1, d: { user: { id: USER_ID }, session_id: 'rt-session', database_history_epoch: EPOCH } } as never);
    await settle();
    expect(phase()).toMatchObject({ phase: 'connected', attempts: 0 });
  });

  it('is not handed the bootstrap refresh that never left the machine', async () => {
    // The home server is this entry (the desktop's case): its refresh shares the home flight.
    setStoredServerUrl(LAN);
    setRefreshToken('refresh-1');
    answer = server({ valid: new Set(), refresh: new Map([['refresh-1', { token: 'access-2', refresh: 'refresh-2' }]]) });

    // Session bootstrap, a moment earlier, before the shell trusted the origin.
    const refused = new AxiosError('Native fetch target is not in the trusted server list', AxiosError.ERR_NETWORK);
    await expect(coordinateRefresh(HOME_REFRESH_SCOPE, async () => { throw refused; })).rejects.toBe(refused);

    await connectionManager.connectAll();
    await settle();

    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0].body).toEqual({ refresh_token: 'refresh-1' });
    expect(useServerListStore.getState().getServer('s_lan')?.token).toBe('access-2');
    // The home session's slot holds the rotated credential too.
    expect(getRefreshToken()).toBe('refresh-2');
    expect(Stream.instances).toHaveLength(1);
  });

  it('retries with back-off when the refresh gets no answer, and connects when it does', async () => {
    let up = false;
    const healthy = server({ valid: new Set(), refresh: new Map([['refresh-1', { token: 'access-2', refresh: 'refresh-2' }]]) });
    answer = (request) => {
      if (request.path === '/api/v1/auth/refresh' && !up) return { status: 503 };
      return healthy(request);
    };

    await connectionManager.connectAll();
    await settle();

    // Nothing was decided about the credential, so it is kept and tried again.
    expect(useServerListStore.getState().getServer('s_lan')).toMatchObject({ token: 'access-expired', refreshToken: 'refresh-1' });
    expect(phase()).toMatchObject({ phase: 'retrying', attempts: 1 });
    expect(phase()?.retryAt).toBeGreaterThan(Date.now());

    await advance(1_000);
    await settle();
    expect(phase()).toMatchObject({ phase: 'retrying', attempts: 2 });

    up = true;
    await advance(2_000);
    await settle();
    expect(useServerListStore.getState().getServer('s_lan')?.token).toBe('access-2');
    expect(Stream.instances).toHaveLength(1);
    expect(phase()?.phase).toBe('connecting');
  });

  it('retries a server that is unreachable at launch until it answers, doubling the wait', async () => {
    const healthy = server({ valid: new Set(['access-expired']), refresh: new Map() });
    let up = false;
    answer = (request) => (up ? healthy(request) : 'unreachable');

    await connectionManager.connectAll();
    await settle();
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const state = phase();
      expect(state).toMatchObject({ phase: 'retrying', attempts: attempt });
      waits.push((state?.retryAt ?? 0) - Date.now());
      await advance(waits.at(-1)! + 10);
      await settle();
    }
    // 1, 2, 4, 8 s, each with up to a fifth taken off so clients do not move in step.
    [1_000, 2_000, 4_000, 8_000].forEach((base, i) => {
      expect(waits[i]).toBeGreaterThanOrEqual(base * 0.8 - 5);
      expect(waits[i]).toBeLessThanOrEqual(base);
    });

    up = true;
    await advance(20_000);
    await settle();
    expect(Stream.instances).toHaveLength(1);
  });

  it('is signed out when the server refuses the refresh, and nothing retries', async () => {
    answer = server({ valid: new Set(), refresh: new Map() });

    await connectionManager.connectAll();
    await settle();

    expect(useServerListStore.getState().getServer('s_lan')).toMatchObject({ token: '', refreshToken: null });
    expect(phase()).toMatchObject({ phase: 'signed-out', endedHere: true });
    const asked = requests.length;
    await advance(120_000);
    expect(requests.length).toBe(asked);

    // A later reconcile (a token change elsewhere, the window regaining focus) neither
    // flashes "Connecting" nor forgets that the session ended here.
    const seen: string[] = [];
    const unsubscribe = useServerConnectionStore.subscribe((state) => seen.push(state.servers.s_lan?.phase ?? 'none'));
    await connectionManager.connectAll().catch(() => {});
    await settle();
    unsubscribe();
    expect(seen.every((value) => value === 'signed-out')).toBe(true);
    expect(phase()).toMatchObject({ phase: 'signed-out', endedHere: true });
  });

  it('is signed out when there is no refresh credential at all (desktop), and nothing retries', async () => {
    useServerListStore.setState({ servers: [entry({ refreshToken: null })] });
    vi.mocked(isTauri).mockReturnValue(true);
    answer = server({ valid: new Set(), refresh: new Map() });
    await connectionManager.connectAll().catch(() => {});
    await settle();
    expect(refreshes()).toHaveLength(0);
    expect(phase()?.phase).toBe('signed-out');
    expect(useServerListStore.getState().getServer('s_lan')?.token).toBe('');
  });
});

describe('a saved server that restarts', () => {
  it('reconnects by itself, refreshing a token that expired while it was down', async () => {
    const valid = new Set(['access-1']);
    const healthy = server({ valid, refresh: new Map([['refresh-1', { token: 'access-2', refresh: 'refresh-2' }]]) });
    let up = true;
    answer = (request) => (up ? healthy(request) : 'unreachable');
    useServerListStore.setState({ servers: [entry({ token: 'access-1' })] });

    await connectionManager.connectAll();
    await settle();
    Stream.instances[0].open();
    expect(Stream.instances).toHaveLength(1);

    // Down, and the access token runs out while it is.
    up = false;
    valid.clear();
    Stream.instances[0].fail();
    await advance(8_000);
    expect(Stream.instances).toHaveLength(1);

    up = true;
    await advance(40_000);
    await settle();
    expect(Stream.instances.length).toBeGreaterThanOrEqual(2);
    expect(useServerListStore.getState().getServer('s_lan')?.token).toBe('access-2');
  });
});

describe('signing in again', () => {
  it('adopts the new session and connects, without a restart', async () => {
    answer = server({ valid: new Set(), refresh: new Map() });
    await connectionManager.connectAll();
    await settle();
    expect(phase()?.phase).toBe('signed-out');

    answer = server({ valid: new Set(['fresh']), refresh: new Map() });
    await connectionManager.adoptServerSession('s_lan', 'fresh', 'fresh-refresh');
    await settle();

    expect(useServerListStore.getState().getServer('s_lan')).toMatchObject({ token: 'fresh', refreshToken: 'fresh-refresh' });
    expect(Stream.instances).toHaveLength(1);
    expect(phase()?.phase).toBe('connecting');
  });

  it('makes a sign-in to the home server the home session too', async () => {
    setStoredServerUrl(LAN);
    answer = server({ valid: new Set(['fresh']), refresh: new Map() });
    await connectionManager.adoptServerSession('s_lan', 'fresh', 'fresh-refresh');
    await settle();
    expect(useAuthStore.getState().token).toBe('fresh');
    expect(getRefreshToken()).toBe('fresh-refresh');
  });
});

describe('the home credential', () => {
  it('is rotated in every copy: a refresh by the home client never leaves the entry holding a spent token', async () => {
    setStoredServerUrl(LAN);
    setRefreshToken('refresh-1');
    useServerListStore.setState({ servers: [entry({ token: 'access-1', refreshToken: 'refresh-1' })] });
    const valid = new Set(['access-1']);
    answer = server({
      valid,
      refresh: new Map([
        ['refresh-1', { token: 'access-2', refresh: 'refresh-2' }],
        ['refresh-2', { token: 'access-3', refresh: 'refresh-3' }],
      ]),
    });
    await connectionManager.connectAll();
    await settle();
    Stream.instances[0].open();

    // The home client (settings, account pages) refreshes the shared credential.
    await refreshSharedSession();
    expect(useServerListStore.getState().getServer('s_lan')).toMatchObject({ token: 'access-2', refreshToken: 'refresh-2' });
    expect(useAuthStore.getState().token).toBe('access-2');

    // Later, the entry's own client meets an expired token and refreshes: with the
    // current credential, not the one the server retired (which revokes every session).
    valid.clear();
    await advance(3_000);
    await manager.connections.get('s_lan')!.apiClient.get('/users/@me');
    expect(refreshes().map((request) => request.body?.refresh_token)).toEqual(['refresh-1', 'refresh-2']);
    expect(useServerListStore.getState().getServer('s_lan')?.refreshToken).toBe('refresh-3');
    expect(getRefreshToken()).toBe('refresh-3');
  });

  it('is never refreshed against another server by the loopback probe', async () => {
    // A second, loopback server with no session of its own; the home session
    // (on the LAN server) is offered to it to see whether it is the same one.
    useAuthStore.setState({ token: 'home-access' });
    setRefreshToken('home-refresh');
    useServerListStore.setState({ servers: [entry({ id: 's_loop', url: 'https://127.0.0.1:8443', token: null, refreshToken: null })] });
    answer = (request) => (request.origin === 'https://127.0.0.1:8443' ? { status: 401, data: { code: 'UNAUTHORIZED', message: 'unauthorized' } } : 'unreachable');

    await connectionManager.connectAll().catch(() => {});
    await settle();

    expect(requests.some((request) => request.origin === 'https://127.0.0.1:8443' && request.path === '/api/v1/users/@me')).toBe(true);
    expect(refreshes()).toHaveLength(0);
    expect(getRefreshToken()).toBe('home-refresh');
    expect(phase('s_loop')).toMatchObject({ phase: 'signed-out', endedHere: false });
  });
});
