import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEDIA_RECONNECT_WINDOW_MS,
  REFRESHED_PIN_REFUSED,
  WebTransportManager,
} from './webTransport';

// The server's media certificate is short-lived on purpose: a browser accepts a
// WebTransport `serverCertificateHashes` pin only for a certificate valid at
// most 14 days, so the server issues a 13-day one and rotates it. That makes the
// pin a *fresh* fact, not a session constant — anything that replays the pin the
// join handed it will, after a rotation, be refused in milliseconds with an
// error a browser reports identically to a blocked UDP port.
//
// These tests drive the transport against a fake WebTransport so the rotation
// can be reproduced exactly: the fake accepts one pin and refuses every other.

type Pin = { algorithm: string; value: Uint8Array };

/** Records what pin each attempt presented, and answers per the current cert. */
class FakeWebTransport {
  static attempts: Array<string | undefined> = [];
  /** Base64 pin the fake server currently presents. Rotate by assigning. */
  static acceptedPin: string | undefined = 'pin-one';
  /** Set to refuse every handshake regardless of pin (a blocked UDP path). */
  static refuseEverything = false;

  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private closeConnection!: () => void;
  private readonly authAck = new Uint8Array([0, 0, 0, 1, 1]);

  readonly datagrams = {
    readable: { getReader: () => this.idleReader() },
    writable: {
      getWriter: () => ({
        write: async () => {},
        releaseLock: () => {},
      }),
    },
  };
  readonly incomingBidirectionalStreams = { getReader: () => this.idleReader() };
  readonly incomingUnidirectionalStreams = { getReader: () => this.idleReader() };

  constructor(_url: string, options?: { serverCertificateHashes?: Pin[] }) {
    const presented = options?.serverCertificateHashes?.[0];
    const pin = presented ? new TextDecoder().decode(presented.value) : undefined;
    FakeWebTransport.attempts.push(pin);
    const accepted = !FakeWebTransport.refuseEverything && pin === FakeWebTransport.acceptedPin;
    this.ready = accepted
      ? Promise.resolve()
      : // Chromium's wording for a refused handshake. Deliberately says nothing
        // about certificates: that indistinguishability is the whole problem.
        Promise.reject(new Error('Opening handshake failed.'));
    this.ready.catch(() => {});
    this.closed = new Promise<void>((resolve) => {
      this.closeConnection = resolve;
    });
  }

  createBidirectionalStream() {
    return Promise.resolve({
      writable: {
        getWriter: () => ({ write: async () => {}, releaseLock: () => {} }),
      },
      readable: {
        getReader: () => {
          let served = false;
          return {
            read: async () => {
              if (served) return new Promise<never>(() => {});
              served = true;
              return { value: this.authAck, done: false };
            },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    });
  }

  close(): void {
    this.closeConnection();
  }

  /** A reader that never yields, so the manager's read loops simply park. */
  private idleReader() {
    return {
      read: () => new Promise<never>(() => {}),
      cancel: async () => {},
      releaseLock: () => {},
    };
  }
}

/**
 * The manager base64-decodes the pin before handing it to WebTransport, so a
 * test pin has to survive `atob` → bytes → `TextDecoder`.
 */
function encodePin(name: string): string {
  return btoa(name);
}

function decodedAttempts(): Array<string | undefined> {
  return FakeWebTransport.attempts.map((pin) => pin);
}

const managers: WebTransportManager[] = [];
function manager(): WebTransportManager {
  const value = new WebTransportManager();
  managers.push(value);
  return value;
}

beforeEach(() => {
  FakeWebTransport.attempts = [];
  FakeWebTransport.refuseEverything = false;
  FakeWebTransport.acceptedPin = 'pin-one';
  vi.stubGlobal('WebTransport', FakeWebTransport);
});

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((value) => value.disconnect()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('media certificate pin freshness', () => {
  it('connects with the pin the join supplied', async () => {
    const transport = manager();
    await transport.connect('https://media.test/media', 'token', encodePin('pin-one'));
    expect(decodedAttempts()).toEqual(['pin-one']);
    expect(transport.isConnected).toBe(true);
  });

  it('refetches the pin once and retries when the server rotated its certificate', async () => {
    // The pin this client cached is the one the server rotated away from.
    FakeWebTransport.acceptedPin = 'pin-two';
    const refresh = vi.fn().mockResolvedValue(encodePin('pin-two'));

    const transport = manager();
    await transport.connect('https://media.test/media', 'token', encodePin('pin-one'), refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(decodedAttempts()).toEqual(['pin-one', 'pin-two']);
    expect(transport.isConnected).toBe(true);
  });

  it('surfaces a specific error when the refreshed pin is refused too', async () => {
    // The server did rotate — the published pin really is different — but the
    // handshake still fails, so this is not a stale-pin problem after all.
    FakeWebTransport.acceptedPin = 'nothing-matches';
    const refresh = vi.fn().mockResolvedValue(encodePin('pin-two'));

    const transport = manager();
    const error = await transport
      .connect('https://media.test/media', 'token', encodePin('pin-one'), refresh)
      .catch((err: Error) => err);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(decodedAttempts()).toEqual(['pin-one', 'pin-two']);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(REFRESHED_PIN_REFUSED);
  });

  it('retries at most once: an unchanged pin is not a certificate problem', async () => {
    // The published pin is the one we already hold, so the failure is the route,
    // not the certificate. Refetching again would only hammer the control plane.
    FakeWebTransport.refuseEverything = true;
    const refresh = vi.fn().mockResolvedValue(encodePin('pin-one'));

    const transport = manager();
    const error = await transport
      .connect('https://media.test/media', 'token', encodePin('pin-one'), refresh)
      .catch((err: Error) => err);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(decodedAttempts()).toEqual(['pin-one']);
    // The original handshake error stands, unembellished by a certificate claim.
    expect((error as Error).message).toBe('Opening handshake failed.');
  });

  it('keeps the cached pin when the control plane cannot be reached either', async () => {
    FakeWebTransport.refuseEverything = true;
    const refresh = vi.fn().mockRejectedValue(new Error('network down'));

    const transport = manager();
    const error = await transport
      .connect('https://media.test/media', 'token', encodePin('pin-one'), refresh)
      .catch((err: Error) => err);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(decodedAttempts()).toEqual(['pin-one']);
    expect((error as Error).message).toBe('Opening handshake failed.');
  });

  it('does not refetch when the caller supplied no refresher', async () => {
    FakeWebTransport.refuseEverything = true;
    const transport = manager();
    await transport
      .connect('https://media.test/media', 'token', encodePin('pin-one'))
      .catch(() => {});
    expect(decodedAttempts()).toEqual(['pin-one']);
  });
});

describe('media certificate pin freshness across a reconnect', () => {
  it('re-reads the pin before every reconnect attempt rather than replaying it', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockImplementation(async () => encodePin(FakeWebTransport.acceptedPin!));

    const transport = manager();
    await transport.connect('https://media.test/media', 'token', encodePin('pin-one'), refresh);
    expect(decodedAttempts()).toEqual(['pin-one']);

    // The session drops, and while it is down the server rotates.
    const live = FakeWebTransport.attempts.length;
    FakeWebTransport.acceptedPin = 'pin-two';
    const closed = vi.fn();
    transport.onClose(closed);
    (transport as unknown as { handleClose(reason: string): void }).handleClose('Connection lost');

    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(0);

    // The reconnect used the rotated pin, on its first attempt — no backoff
    // spent failing against a certificate the server no longer presents.
    expect(FakeWebTransport.attempts.length).toBe(live + 1);
    expect(decodedAttempts().at(-1)).toBe('pin-two');
    expect(transport.isConnected).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  });

  it('re-arms the one-shot retry after a successful handshake', async () => {
    vi.useFakeTimers();
    // The refresher is deliberately stale on the reconnect path so the reactive
    // retry — not the proactive refresh — is what has to save the reconnect.
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(encodePin('pin-one')) // proactive refresh: stale
      .mockResolvedValue(encodePin('pin-two')); // reactive refetch: current

    const transport = manager();
    await transport.connect('https://media.test/media', 'token', encodePin('pin-one'), refresh);
    expect(refresh).toHaveBeenCalledTimes(0);

    FakeWebTransport.acceptedPin = 'pin-two';
    (transport as unknown as { handleClose(reason: string): void }).handleClose('Connection lost');
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(0);

    // Proactive refresh returned the stale pin, the handshake failed, and the
    // one-shot refetch (re-armed by the original successful connect) recovered.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(decodedAttempts()).toEqual(['pin-one', 'pin-one', 'pin-two']);
    expect(transport.isConnected).toBe(true);
  });
});

describe('a dropped media connection', () => {
  it('announces the interruption at once, and the restore when it comes back', async () => {
    vi.useFakeTimers();
    const transport = manager();
    await transport.connect('https://media.test/media', 'token', encodePin('pin-one'));

    const interrupted: string[] = [];
    const restored = vi.fn();
    const closed = vi.fn();
    transport.onInterrupt((reason) => interrupted.push(reason));
    transport.onRestored(restored);
    transport.onClose(closed);

    (transport as unknown as { handleClose(reason: string): void }).handleClose('Connection lost');
    // Announced before the first retry has even been attempted: the call is not
    // carrying anybody's voice from this moment, not from the moment the budget
    // runs out.
    expect(interrupted).toEqual(['Connection lost']);
    expect(closed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.isConnected).toBe(true);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it('ends the call inside the reconnect window instead of pretending for minutes', async () => {
    vi.useFakeTimers();
    const transport = manager();
    await transport.connect('https://media.test/media', 'token', encodePin('pin-one'));

    const closed = vi.fn();
    transport.onClose(closed);

    // The server goes away — a restart, a crash, a dead route.
    FakeWebTransport.refuseEverything = true;
    const started = Date.now();
    (transport as unknown as { handleClose(reason: string): void }).handleClose('Connection lost');

    // Just inside the window it is still trying, and has not lied about it.
    await vi.advanceTimersByTimeAsync(MEDIA_RECONNECT_WINDOW_MS - 3_000);
    expect(closed).not.toHaveBeenCalled();

    // Just past it, the call is declared over — once.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(MEDIA_RECONNECT_WINDOW_MS + 6_000);
  });
});
