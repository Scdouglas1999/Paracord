import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../../../api/activeClient', () => ({ getApi: () => ({ get: apiGet }) }));

import {
  PROBE_TIMEOUT_MESSAGE,
  classifyTransportError,
  createServerAdapter,
  createTransportAdapter,
  parseTransportConfig,
  stripUrlCredentials,
} from './browserAdapters';

const PIN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('stripUrlCredentials', () => {
  it('removes an embedded user and password from an absolute URL', () => {
    expect(stripUrlCredentials('https://ada:hunter2@chat.example.com:8443/media')).toBe(
      'https://chat.example.com:8443/media',
    );
  });

  it('removes a credential pair from a bare authority', () => {
    expect(stripUrlCredentials('ada:hunter2@chat.example.com:8443')).toBe('chat.example.com:8443');
  });

  it('leaves a plain host untouched', () => {
    expect(stripUrlCredentials('chat.example.com:8443')).toBe('chat.example.com:8443');
  });
});

describe('parseTransportConfig', () => {
  it('reads a native payload', () => {
    const config = parseTransportConfig({
      transport: 'native',
      voice_available: true,
      media_endpoint: 'https://chat.example.com:8443/media',
      media_endpoint_candidates: ['https://10.0.0.4:8443/media', 'https://chat.example.com:8443/media'],
      media_udp_port: 8443,
      certificate_pin_sha256: PIN,
      certificate_source: 'server-generated-self-signed',
      livekit_available: false,
      e2ee_required: true,
      max_participants: 50,
    });
    expect(config.transport).toBe('native');
    expect(config.mediaUdpPort).toBe(8443);
    expect(config.certificatePinSha256).toBe(PIN);
    expect(config.mediaEndpointCandidates).toHaveLength(2);
  });

  it('strips credentials from every advertised endpoint', () => {
    const config = parseTransportConfig({
      transport: 'native',
      voice_available: true,
      media_endpoint: 'https://ada:hunter2@chat.example.com:8443/media',
      media_endpoint_candidates: ['https://ada:hunter2@10.0.0.4:8443/media'],
      media_udp_port: 8443,
      certificate_pin_sha256: PIN,
      certificate_source: 'server-generated-self-signed',
    });
    expect(config.mediaEndpoint).toBe('https://chat.example.com:8443/media');
    expect(config.mediaEndpointCandidates[0]).toBe('https://10.0.0.4:8443/media');
  });

  it('reads a server with no call transport', () => {
    const config = parseTransportConfig({ transport: 'none', voice_available: false });
    expect(config.transport).toBe('none');
    expect(config.mediaEndpoint).toBeNull();
    expect(config.certificateSource).toBe('none');
  });

  it('refuses a payload it does not understand rather than guessing', () => {
    expect(() => parseTransportConfig({ transport: 'magic' })).toThrow(/unrecognised call transport/i);
    expect(() => parseTransportConfig(null)).toThrow(/no voice transport information/i);
  });
});

describe('createServerAdapter', () => {
  beforeEach(() => apiGet.mockReset());

  it('asks the side-effect-free diagnostics route, never a join endpoint', async () => {
    apiGet.mockResolvedValue({
      data: { transport: 'none', voice_available: false },
    });
    const config = await createServerAdapter().fetchTransportConfig();
    // Relative to the client's `/api/v1` baseURL — an absolute `/api/v1/...`
    // here resolves to `/api/v1/api/v1/...` and 404s.
    expect(apiGet).toHaveBeenCalledWith('/voice/transport-diagnostics', expect.anything());
    expect(config.transport).toBe('none');
  });
});

describe('classifyTransportError', () => {
  it('calls a run past the budget a timeout', () => {
    expect(classifyTransportError(new Error('no reply'), 8000, 8000).failure).toBe('timeout');
  });

  it('recognises its own deadline even when the clock rounds a millisecond short', () => {
    expect(
      classifyTransportError(new Error(`${PROBE_TIMEOUT_MESSAGE} 8000 ms.`), 7999, 8000).failure,
    ).toBe('timeout');
  });

  it('recognises a refused certificate', () => {
    expect(classifyTransportError(new Error('CERT_AUTHORITY_INVALID'), 10, 8000).failure).toBe(
      'certificate-refused',
    );
  });

  it('recognises an address that never resolved', () => {
    expect(classifyTransportError(new Error('ERR_NAME_NOT_RESOLVED'), 10, 8000).failure).toBe('unreachable');
  });

  it('recognises a QUIC handshake that started and stopped', () => {
    expect(classifyTransportError(new Error('Opening handshake failed.'), 10, 8000).failure).toBe(
      'handshake-failed',
    );
  });

  it('never invents a cause it cannot support', () => {
    expect(classifyTransportError(new Error('something else'), 10, 8000).failure).toBe('unknown');
  });
});

describe('createTransportAdapter', () => {
  const original = (globalThis as { WebTransport?: unknown }).WebTransport;

  afterEach(() => {
    if (original === undefined) delete (globalThis as { WebTransport?: unknown }).WebTransport;
    else (globalThis as { WebTransport?: unknown }).WebTransport = original;
  });

  function installWebTransport(impl: (url: string, options?: unknown) => unknown) {
    // A plain function, not an arrow: the adapter calls `new WebTransport(...)`
    // and an arrow function cannot be used as a constructor.
    (globalThis as { WebTransport?: unknown }).WebTransport = function FakeWebTransport(
      this: unknown,
      url: string,
      options?: unknown,
    ) {
      return impl(url, options);
    } as unknown;
  }

  function fakeSession(overrides: Record<string, unknown> = {}) {
    return {
      ready: Promise.resolve(),
      closed: new Promise(() => {}),
      createBidirectionalStream: async () => ({
        writable: { close: async () => {} },
        readable: {},
      }),
      close: () => {},
      ...overrides,
    };
  }

  it('reports unsupported when the runtime has no WebTransport', async () => {
    delete (globalThis as { WebTransport?: unknown }).WebTransport;
    const outcome = await createTransportAdapter(() => 0).probe({
      endpoint: 'https://chat.example.com:8443/media',
      certificatePinSha256: PIN,
      timeoutMs: 100,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('unsupported');
  });

  it('pins the server certificate and reports the round trip', async () => {
    let seenOptions: { serverCertificateHashes?: Array<{ algorithm: string; value: Uint8Array }> } | undefined;
    installWebTransport((_url, options) => {
      seenOptions = options as typeof seenOptions;
      return fakeSession();
    });
    let tick = 0;
    const outcome = await createTransportAdapter(() => (tick += 21)).probe({
      endpoint: 'https://chat.example.com:8443/media',
      certificatePinSha256: PIN,
      timeoutMs: 1000,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.rttMs).toBe(21);
    expect(outcome.streamOpened).toBe(true);
    expect(seenOptions?.serverCertificateHashes?.[0].algorithm).toBe('sha-256');
    expect(seenOptions?.serverCertificateHashes?.[0].value).toHaveLength(32);
  });

  it('refuses a fingerprint that is not a SHA-256 digest', async () => {
    installWebTransport(() => fakeSession());
    const outcome = await createTransportAdapter(() => 0).probe({
      endpoint: 'https://chat.example.com:8443/media',
      certificatePinSha256: 'AAAA',
      timeoutMs: 1000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('certificate-refused');
    expect(outcome.detail).toContain('SHA-256');
  });

  it('reports a timeout when nothing answers within the budget', async () => {
    installWebTransport(() => fakeSession({ ready: new Promise(() => {}) }));
    const outcome = await createTransportAdapter(() => Date.now()).probe({
      endpoint: 'https://chat.example.com:8443/media',
      certificatePinSha256: PIN,
      timeoutMs: 30,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('timeout');
  });

  it('reports a session the peer closed during the handshake', async () => {
    installWebTransport(() =>
      fakeSession({ ready: new Promise(() => {}), closed: Promise.resolve() }),
    );
    let tick = 0;
    const outcome = await createTransportAdapter(() => (tick += 1)).probe({
      endpoint: 'https://chat.example.com:8443/media',
      certificatePinSha256: PIN,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('closed the session');
  });

  it('still reports success when the peer refuses a stream on a ready session', async () => {
    installWebTransport(() =>
      fakeSession({
        createBidirectionalStream: async () => {
          throw new Error('stream reset');
        },
      }),
    );
    let tick = 0;
    const outcome = await createTransportAdapter(() => (tick += 7)).probe({
      endpoint: 'https://chat.example.com:8443/media',
      certificatePinSha256: PIN,
      timeoutMs: 1000,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.streamOpened).toBe(false);
  });
});
