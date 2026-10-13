import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * After a restore and before sign-in the app asked for a download ticket three
 * or four times a second, and the server answered 401 every time: avatars on the
 * sign-in screen subscribe to tickets, the mint failed, and the failure path
 * re-armed a short retry that its own success path reset.
 */

const ORIGIN = 'https://host.example';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

function fakeApiClient() {
  return { defaults: { baseURL: `${ORIGIN}/api/v1` }, post: mocks.post };
}

vi.mock('../api/activeClient', () => ({ getApi: () => fakeApiClient() }));
vi.mock('./connectionManager', () => ({
  LOCAL_SERVER_ID: '__local__',
  connectionManager: { getActiveApiClient: () => fakeApiClient() },
}));

function unauthorized() {
  return Object.assign(new Error('Request failed with status code 401'), {
    response: { status: 401 },
  });
}

async function setup(token: string | null) {
  vi.resetModules();
  mocks.post.mockReset();
  const apiBaseUrl = await import('./config/apiBaseUrl');
  apiBaseUrl.setStoredServerUrl(ORIGIN);
  const { useServerListStore } = await import('../stores/serverListStore');
  useServerListStore.setState({
    servers: [{ id: 'home', url: ORIGIN, name: 'Home', token, connected: true }],
    activeServerId: 'home',
  });
  const downloadTicket = await import('./downloadTicket');
  return { ...downloadTicket, useServerListStore };
}

describe('download ticket without a session', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_API_URL', '');
    localStorage.clear();
    sessionStorage.clear();
  });

  it('does not ask the server before anyone is signed in', async () => {
    vi.useFakeTimers();
    try {
      const { ensureDownloadTicket, subscribeDownloadTicket } = await setup(null);
      subscribeDownloadTicket(() => {});
      await expect(ensureDownloadTicket()).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.post).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after a 401 instead of retrying every few hundred milliseconds', async () => {
    vi.useFakeTimers();
    try {
      const { ensureDownloadTicket } = await setup('stale-token');
      mocks.post.mockRejectedValue(unauthorized());

      await expect(ensureDownloadTicket()).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(ensureDownloadTicket()).resolves.toBeNull();

      expect(mocks.post).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again once there is a different session', async () => {
    const { ensureDownloadTicket, useServerListStore } = await setup('stale-token');
    mocks.post.mockRejectedValueOnce(unauthorized());
    await ensureDownloadTicket();
    expect(mocks.post).toHaveBeenCalledTimes(1);

    useServerListStore.setState({
      servers: [{ id: 'home', url: ORIGIN, name: 'Home', token: 'fresh-token', connected: true }],
    });
    mocks.post.mockResolvedValue({ data: { ticket: 'TICKET' } });
    await expect(ensureDownloadTicket()).resolves.toBe('TICKET');
  });

  it('still retries a failure that is not a 401', async () => {
    vi.useFakeTimers();
    try {
      const { ensureDownloadTicket, getDownloadTicket } = await setup('good-token');
      mocks.post.mockRejectedValueOnce(new Error('network down'));
      mocks.post.mockResolvedValue({ data: { ticket: 'TICKET' } });
      await ensureDownloadTicket();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getDownloadTicket()).toBe('TICKET');
    } finally {
      vi.useRealTimers();
    }
  });
});
