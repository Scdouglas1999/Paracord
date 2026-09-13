import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserMediaEngine } from './browserMediaEngine';

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
