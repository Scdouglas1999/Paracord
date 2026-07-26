import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F17 regression: the download ticket was MINTED through the active server but
 * KEYED and SERVED against the stored (home) server, and `resolveResourceUrl`
 * rewrote relative resource paths onto that stored origin.
 *
 * Once the two diverge — which is routine the moment the user switches spaces —
 * avatar/emoji/sticker requests for the active server's users went to the home
 * server's origin (disclosing what the victim is viewing elsewhere), and in the
 * other ordering a ticket minted at one server was appended as `?ticket=…` to a
 * URL at another: a 240s multi-use bearer credential, in a query string, sent to
 * a server that did not issue it, where query strings land in access logs.
 *
 * The invariant these tests pin: the mint, the cache key and the target origin
 * are all the same server, or no ticket exists at all.
 */

const HOME_ORIGIN = 'https://home.example';
const REMOTE_ORIGIN = 'https://remote.example';

const mocks = vi.hoisted(() => ({
  /** Base URL of the axios instance `getApi()` resolves to. */
  activeClientBaseUrl: '' as string | null,
  post: vi.fn(),
}));

function fakeApiClient() {
  return {
    defaults: { baseURL: mocks.activeClientBaseUrl },
    post: mocks.post,
  };
}

vi.mock('../api/activeClient', () => ({ getApi: () => fakeApiClient() }));
vi.mock('./connectionManager', () => ({
  LOCAL_SERVER_ID: '__local__',
  connectionManager: {
    // Mirrors the real resolver: undefined means `getApi()` falls back to the
    // LOCAL singleton, whose base URL is the stored/home server.
    getActiveApiClient: () =>
      mocks.activeClientBaseUrl === null ? undefined : fakeApiClient(),
  },
}));

/**
 * @param activeServer  which server the UI is focused on
 * @param mintingOrigin origin of the client that would mint the ticket, or
 *                      null to simulate "no per-server client yet" (the LOCAL
 *                      singleton, i.e. the home server)
 */
async function setup(activeServer: 'home' | 'remote', mintingOrigin: string | null) {
  vi.resetModules();
  mocks.post.mockReset();
  mocks.activeClientBaseUrl = mintingOrigin === null ? null : `${mintingOrigin}/api/v1`;

  const apiBaseUrl = await import('./config/apiBaseUrl');
  apiBaseUrl.setStoredServerUrl(HOME_ORIGIN);

  const { useServerListStore } = await import('../stores/serverListStore');
  useServerListStore.setState({
    servers: [
      { id: 'home', url: HOME_ORIGIN, name: 'Home', token: 'home-token', connected: true },
      { id: 'remote', url: REMOTE_ORIGIN, name: 'Remote', token: 'remote-token', connected: true },
    ],
    activeServerId: activeServer,
  });

  const downloadTicket = await import('./downloadTicket');
  return { ...apiBaseUrl, ...downloadTicket, useServerListStore };
}

describe('download ticket / resource URL server binding', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_API_URL', '');
    localStorage.clear();
    sessionStorage.clear();
  });

  it('resolves resource paths against the active server, not the stored one', async () => {
    const { resolveResourceUrl } = await setup('remote', REMOTE_ORIGIN);

    expect(resolveResourceUrl('/api/v1/users/1/avatar', null)).toBe(
      `${REMOTE_ORIGIN}/api/v1/users/1/avatar`,
    );
  });

  it('mints through the active server and serves the ticket back for that server', async () => {
    const { ensureDownloadTicket, getDownloadTicket, resolveResourceUrl } = await setup(
      'remote',
      REMOTE_ORIGIN,
    );
    mocks.post.mockResolvedValue({ data: { ticket: 'REMOTE-TICKET' } });

    await expect(ensureDownloadTicket()).resolves.toBe('REMOTE-TICKET');
    expect(mocks.post).toHaveBeenCalledWith('/download/ticket');
    expect(getDownloadTicket()).toBe('REMOTE-TICKET');

    expect(resolveResourceUrl('/api/v1/users/1/avatar', getDownloadTicket())).toBe(
      `${REMOTE_ORIGIN}/api/v1/users/1/avatar?ticket=REMOTE-TICKET`,
    );
  });

  it('drops a ticket minted at the home server once the active server changes', async () => {
    const ctx = await setup('home', HOME_ORIGIN);
    mocks.post.mockResolvedValue({ data: { ticket: 'HOME-TICKET' } });

    await expect(ctx.ensureDownloadTicket()).resolves.toBe('HOME-TICKET');
    expect(ctx.getDownloadTicket()).toBe('HOME-TICKET');

    // The user clicks the remote server's space. Its per-server client becomes
    // the active one; the stored (home) server URL does not change.
    ctx.useServerListStore.setState({ activeServerId: 'remote' });
    mocks.activeClientBaseUrl = `${REMOTE_ORIGIN}/api/v1`;

    expect(ctx.getDownloadTicket()).toBeNull();

    const url = ctx.resolveResourceUrl('/api/v1/users/1/avatar', ctx.getDownloadTicket());
    expect(url).toBe(`${REMOTE_ORIGIN}/api/v1/users/1/avatar`);
    expect(url).not.toContain('ticket=');
    expect(url).not.toContain('HOME-TICKET');
  });

  it('mints nothing while the minting client and the active server disagree', async () => {
    // Active server is the remote one, but its connection is not up yet, so a
    // mint would be issued by the home server and cached under the remote key.
    const { ensureDownloadTicket, getDownloadTicket } = await setup('remote', null);
    mocks.post.mockResolvedValue({ data: { ticket: 'HOME-TICKET' } });

    await expect(ensureDownloadTicket()).resolves.toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(getDownloadTicket()).toBeNull();
  });

  it('never appends a ticket to a foreign origin', async () => {
    const { resolveResourceUrl } = await setup('remote', REMOTE_ORIGIN);

    expect(resolveResourceUrl('https://evil.example/p.png', 'REMOTE-TICKET')).toBe(
      'https://evil.example/p.png',
    );
    // The home server is just as foreign to a ticket the remote server minted.
    expect(resolveResourceUrl(`${HOME_ORIGIN}/p.png`, 'REMOTE-TICKET')).toBe(
      `${HOME_ORIGIN}/p.png`,
    );
  });
});
