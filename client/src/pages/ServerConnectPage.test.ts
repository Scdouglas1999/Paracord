import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/tauriEnv', () => ({
  isTauri: () => false,
}));

import {
  CorsBlockedError,
  corsBlockedMessage,
  explainConnectionFailure,
  probeRespondsWithoutCors,
  toFriendlyConnectionError,
  unreachableOrCorsBlockedMessage,
} from './ServerConnectPage';

const ORIGIN = 'http://127.0.0.1:18240';

/**
 * What a `no-cors` fetch resolves with: an opaque response whose body, status
 * and headers are all unreadable. Nothing in the probe touches it — the fact
 * that the promise resolved at all is the whole signal — so a stand-in is
 * enough, and it is more honest than a readable 200 that could never occur.
 */
const OPAQUE_RESPONSE = { type: 'opaque', status: 0, ok: false } as unknown as Response;

describe('the connect wizard explains a CORS refusal', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // jsdom's default origin is not the one an operator would be reading off
    // their address bar; pin it so the asserted message is the exact sentence.
    Object.defineProperty(window, 'location', {
      value: { ...window.location, origin: ORIGIN },
      writable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('names the host, the setting its operator needs, and the desktop caveat', () => {
    const message = corsBlockedMessage('127.0.0.1:18244', ORIGIN);
    expect(message).toContain('127.0.0.1:18244');
    expect(message).toContain(`PARACORD_CORS_ALLOWED_ORIGINS=${ORIGIN}`);
    expect(message).toContain('desktop app is not affected');
    // The whole point is that it is NOT the generic failure.
    expect(message.toLowerCase()).not.toContain('check dns');
  });

  it('keeps the specific message when the error is already a CORS refusal', () => {
    const err = new CorsBlockedError('chat.example.com', ORIGIN);
    expect(toFriendlyConnectionError(err)).toBe(corsBlockedMessage('chat.example.com', ORIGIN));
  });

  it('treats a resolving no-cors probe as proof the server is up', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(OPAQUE_RESPONSE);
    await expect(probeRespondsWithoutCors('http://127.0.0.1:18244')).resolves.toBe(true);
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.mode).toBe('no-cors');
  });

  it('treats a rejecting no-cors probe as a genuinely unreachable server', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(probeRespondsWithoutCors('http://127.0.0.1:18244')).resolves.toBe(false);
  });

  /**
   * The per-server axios client reports a refused preflight as `ERR_NETWORK`,
   * which is indistinguishable from an unreachable host until the no-cors probe
   * answers. This is the case the blocker was filed for.
   */
  it('upgrades an opaque axios network error against a reachable host', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(OPAQUE_RESPONSE);
    const axiosLike = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

    await expect(explainConnectionFailure(axiosLike, 'http://127.0.0.1:18244')).resolves.toBe(
      corsBlockedMessage('127.0.0.1:18244', ORIGIN),
    );
  });

  /**
   * A Paracord peer sends `Cross-Origin-Resource-Policy: same-origin` on every
   * response, `/health` included, so the browser blocks the opaque probe after
   * the answer arrives and it rejects exactly as a dead host does. Verified
   * live: a no-cors probe of a running peer rejects, while the same probe of a
   * CORP-less host resolves. A rejecting probe therefore cannot be read as
   * proof the server is down, and the message keeps both causes.
   */
  it('keeps the allowlist on screen when the probe cannot settle the question', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const axiosLike = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

    const message = await explainConnectionFailure(axiosLike, 'http://127.0.0.1:18244');
    expect(message).toBe(unreachableOrCorsBlockedMessage('127.0.0.1:18244', ORIGIN));
    expect(message).toContain(`PARACORD_CORS_ALLOWED_ORIGINS=${ORIGIN}`);
    expect(message).toContain('127.0.0.1:18244');
    // It must not assert a cause it cannot know.
    expect(message.toLowerCase()).not.toContain('check dns');
  });

  it('does not reach for the allowlist when there is no server url to name', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const axiosLike = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

    const message = await explainConnectionFailure(axiosLike);
    expect(message).not.toContain('PARACORD_CORS_ALLOWED_ORIGINS');
    expect(message).toContain('Network Error');
  });

  it('does not blame CORS for an error that is not a network failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(OPAQUE_RESPONSE);

    const message = await explainConnectionFailure(
      new Error('Not a Paracord server'),
      'http://127.0.0.1:18244',
    );
    expect(message).toContain('does not identify as a Paracord server');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
