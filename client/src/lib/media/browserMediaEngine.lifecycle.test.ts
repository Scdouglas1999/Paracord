import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserMediaEngine } from './browserMediaEngine';
import { WebTransportManager } from './transport/webTransport';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function capturedStream() {
  const stop = vi.fn();
  return { stop, stream: { getTracks: () => [{ stop }] } as unknown as MediaStream };
}
afterEach(() => vi.unstubAllGlobals());

describe('BrowserMediaEngine late permission results', () => {
  it('stops a microphone granted after disconnect without constructing an audio context', async () => {
    const permission = deferred<MediaStream>();
    const AudioContext = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission.promise } });
    vi.stubGlobal('AudioContext', AudioContext);
    const engine = new BrowserMediaEngine();
    const capture = (engine as unknown as { setupAudioCapture(): Promise<void> }).setupAudioCapture();
    const result = capture.catch(error => error);
    await engine.disconnect();
    const late = capturedStream();
    permission.resolve(late.stream);
    expect((await result).name).toBe('AbortError');
    expect(late.stop).toHaveBeenCalledTimes(1);
    expect(AudioContext).not.toHaveBeenCalled();
  });

  it('stops a camera granted after disable while the call remains alive', async () => {
    const permission = deferred<MediaStream>();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission.promise } });
    const engine = new BrowserMediaEngine();
    const enable = engine.enableVideo(true).catch(error => error);
    await engine.enableVideo(false);
    const late = capturedStream();
    permission.resolve(late.stream);
    expect((await enable).name).toBe('AbortError');
    expect(late.stop).toHaveBeenCalledTimes(1);
    await engine.disconnect();
  });

  it('stops a screen selection returned after stop without creating an encoder', async () => {
    const permission = deferred<MediaStream>();
    const requested = deferred<void>();
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: () => { requested.resolve(); return permission.promise; } } });
    const engine = new BrowserMediaEngine();
    const start = engine.startScreenShare({ audio: false, preferredCodec: 'vp9' }).catch(error => error);
    await requested.promise;
    await engine.stopScreenShare();
    const late = capturedStream();
    permission.resolve(late.stream);
    expect((await start).name).toBe('AbortError');
    expect(late.stop).toHaveBeenCalledTimes(1);
    await engine.disconnect();
  });
});

describe('BrowserMediaEngine media certificate pin', () => {
  /** A media token shaped enough for connect(): it only reads the claims. */
  function mediaToken(): string {
    const claims = btoa(JSON.stringify({ sid: 'session-1', sub: '7', room: '9' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    return `header.${claims}.signature`;
  }

  it('hands the transport a way to re-read the pin, not just the joined-with pin', async () => {
    // The pin is a fresh fact: the server rotates its media certificate inside
    // the 14-day window browsers require of a pinned one. An engine that only
    // forwarded the join's pin would be refused on every reconnect afterwards.
    const connect = vi
      .spyOn(WebTransportManager.prototype, 'connect')
      .mockResolvedValue(undefined);
    // Stop the join right after the transport is up; nothing below it is under test.
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('no capture in tests')) },
    });

    const refreshCertHash = vi.fn().mockResolvedValue('rotated-pin');
    const engine = new BrowserMediaEngine();
    await engine
      .connect('https://media.test/media', mediaToken(), 'joined-with-pin', {
        id: 'call-1',
        signal: new AbortController().signal,
        refreshCertHash,
      })
      .catch(() => {});

    expect(connect).toHaveBeenCalledWith(
      'https://media.test/media',
      expect.any(String),
      'joined-with-pin',
      refreshCertHash,
    );
    connect.mockRestore();
    await engine.disconnect();
  });
});
