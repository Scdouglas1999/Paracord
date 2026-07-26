import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F16 regression: on desktop the attachment URL and the credential used to
 * fetch it came from two different servers. The URL was built from the ACTIVE
 * server (`getApi().defaults.baseURL`) while the Authorization header carried
 * the process-global access token, which belongs to the HOME server alone.
 *
 * A hostile server the user has joined only has to render a message with an
 * image attachment: the message list resolves it on render, with no click, and
 * the native fetch would arrive at the hostile origin carrying the home
 * server's bearer token.
 *
 * The invariant these tests pin: a credential is only ever presented to the
 * origin that issued it.
 */

const HOME_ORIGIN = 'https://home.example';
const HOSTILE_ORIGIN = 'https://hostile.example';
const HOME_TOKEN = 'home-server-access-token';
const HOSTILE_TOKEN = 'hostile-server-access-token';
const CSRF_VALUE = 'csrf-cookie-value';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  activeBaseUrl: '',
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../lib/tauriEnv', () => ({ isTauri: () => true }));
vi.mock('./activeClient', () => ({
  getApi: () => ({ defaults: { baseURL: mocks.activeBaseUrl } }),
}));
vi.mock('../lib/downloadTicket', () => ({
  ensureDownloadTicket: vi.fn(async () => null),
  getDownloadTicket: () => null,
}));
vi.mock('../lib/media/transport/fileTransfer', () => ({ QUICFileUploader: class {} }));
vi.mock('../lib/media/transport/fileTransportManager', () => ({
  FileTransportManager: { getInstance: () => ({}) },
  hasQuicTransport: () => false,
}));

interface NativeRequest {
  url: string;
  headers: Record<string, string> | null;
}

function lastNativeRequest(): NativeRequest {
  const call = mocks.invoke.mock.calls.at(-1);
  if (!call) throw new Error('native command was never invoked');
  return (call[1] as { req: NativeRequest }).req;
}

/**
 * Wire up a two-server desktop session: the home server holds the global
 * access token, and `activeServerId` points at a second, hostile server that
 * has its own per-server token.
 */
async function setupTwoServerSession(hostileToken: string | null) {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.activeBaseUrl = `${HOSTILE_ORIGIN}/api/v1`;

  const { setStoredServerUrl } = await import('../lib/config/apiBaseUrl');
  setStoredServerUrl(HOME_ORIGIN);

  const { setAccessToken } = await import('../lib/authToken');
  setAccessToken(HOME_TOKEN);

  const { useServerListStore } = await import('../stores/serverListStore');
  useServerListStore.setState({
    servers: [
      {
        id: 'home',
        url: HOME_ORIGIN,
        name: 'Home',
        token: HOME_TOKEN,
        connected: true,
      },
      {
        id: 'hostile',
        url: HOSTILE_ORIGIN,
        name: 'Hostile',
        token: hostileToken,
        connected: true,
      },
    ],
    activeServerId: 'hostile',
  });

  return import('./files');
}

describe('files native fetch credential binding', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_API_URL', '');
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = `paracord_csrf=${CSRF_VALUE}`;
    // jsdom has no object-URL support; the code under test only needs a value.
    URL.createObjectURL = vi.fn(() => 'blob:stub');
  });

  it('downloads from the active server with that server\'s token, never the home token', async () => {
    const { fileApi } = await setupTwoServerSession(HOSTILE_TOKEN);
    mocks.invoke.mockResolvedValue({
      status: 200,
      content_type: 'image/png',
      data_base64: '',
    });

    await fileApi.download('9001');

    const req = lastNativeRequest();
    expect(req.url).toBe(`${HOSTILE_ORIGIN}/api/v1/attachments/9001`);
    expect(req.headers?.Authorization).toBe(`Bearer ${HOSTILE_TOKEN}`);
    expect(JSON.stringify(req.headers)).not.toContain(HOME_TOKEN);
  });

  it('uploads to the active server with that server\'s token, never the home token', async () => {
    const { fileApi } = await setupTwoServerSession(HOSTILE_TOKEN);
    mocks.invoke.mockResolvedValue({
      status: 200,
      body: { id: '1', filename: 'a.png', size: 3, content_type: 'image/png', url: '/x' },
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    await fileApi.upload('chan-1', file);

    const req = lastNativeRequest();
    expect(req.url).toBe(`${HOSTILE_ORIGIN}/api/v1/channels/chan-1/attachments`);
    expect(req.headers?.Authorization).toBe(`Bearer ${HOSTILE_TOKEN}`);
    expect(JSON.stringify(req.headers)).not.toContain(HOME_TOKEN);
  });

  it('sends no credential at all to an origin it holds no token for', async () => {
    // The absolute-URL branch: `avatar_hash` and attachment URLs may be
    // arbitrary absolute URLs chosen by whoever authored the message.
    const { fileApi } = await setupTwoServerSession(HOSTILE_TOKEN);
    mocks.invoke.mockResolvedValue({
      status: 200,
      content_type: 'image/png',
      data_base64: '',
    });

    await fileApi.resolveAttachmentObjectUrl('https://evil.example/beacon.png');

    const req = lastNativeRequest();
    expect(req.url).toBe('https://evil.example/beacon.png');
    // No Authorization, and no CSRF value either: the double-submit token is
    // only meaningful next to the session it protects.
    expect(req.headers).toBeNull();
  });

  it('sends no credential when the active server has no token of its own', async () => {
    const { fileApi } = await setupTwoServerSession(null);
    mocks.invoke.mockResolvedValue({
      status: 200,
      content_type: 'image/png',
      data_base64: '',
    });

    await fileApi.download('9001');

    const req = lastNativeRequest();
    expect(req.url).toBe(`${HOSTILE_ORIGIN}/api/v1/attachments/9001`);
    expect(req.headers).toBeNull();
  });

  it('still presents the global token to the home server it was issued for', async () => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.activeBaseUrl = `${HOME_ORIGIN}/api/v1`;

    const { setStoredServerUrl } = await import('../lib/config/apiBaseUrl');
    setStoredServerUrl(HOME_ORIGIN);
    const { setAccessToken } = await import('../lib/authToken');
    setAccessToken(HOME_TOKEN);
    const { useServerListStore } = await import('../stores/serverListStore');
    useServerListStore.setState({ servers: [], activeServerId: null });

    const { fileApi } = await import('./files');
    mocks.invoke.mockResolvedValue({
      status: 200,
      content_type: 'image/png',
      data_base64: '',
    });

    await fileApi.download('9001');

    const req = lastNativeRequest();
    expect(req.url).toBe(`${HOME_ORIGIN}/api/v1/attachments/9001`);
    expect(req.headers?.Authorization).toBe(`Bearer ${HOME_TOKEN}`);
    expect(req.headers?.['X-Paracord-CSRF']).toBe(CSRF_VALUE);
  });
});
