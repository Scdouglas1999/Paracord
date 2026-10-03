import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The room's ambient view on the desktop's native-surface route (WP-G23): no
// frame reaches the webview there, so a frame tap with no surface showing the
// track attaches a sampler surface in the shell (`native_render_attach_sampler`)
// and registers the relay subscription, so the native side decodes the lowest
// layer for `native_render_sample` to read. Its release detaches both.

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  renderers: [] as Array<{ fit?: string; anchor?: unknown }>,
  tiles: [] as Array<{ fit?: string; anchor?: unknown; trackId: string; occlusion?: unknown }>,
  underlay: false,
  webCodecs: false,
  attachSampler: null as null | (() => Promise<unknown>),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, Channel: class { onmessage = null; } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('./video/canvasRenderer', () => ({
  CanvasRenderer: class {
    constructor(readonly canvasElement: HTMLCanvasElement, options?: { fit?: string; anchor?: unknown }) {
      ipc.renderers.push({ fit: options?.fit, anchor: options?.anchor });
    }
    setRenderingEnabled() {}
    renderFrame(frame: { close(): void }) { frame.close(); }
    destroy() {}
  },
}));
vi.mock('./video/nativeVideoTile', () => ({
  NativeVideoTile: class {
    constructor(options: { fit?: string; anchor?: unknown; trackId: string; occlusion?: unknown }) {
      ipc.tiles.push({ fit: options.fit, anchor: options.anchor, trackId: options.trackId, occlusion: options.occlusion });
    }
    attach() { return new Promise(() => {}); }
    destroy() {}
  },
}));
vi.mock('./video/videoDecoder', () => ({
  MediaVideoDecoder: class {
    onDecoded() {}
    onError() {}
    onKeyframeNeeded() {}
    decode() {}
    reset() {}
    close() {}
  },
  isWebCodecsDecodeSupported: vi.fn(async () => ipc.webCodecs),
}));
import { TauriMediaEngine } from './tauriMediaEngine';

function token(): string {
  const body = btoa(JSON.stringify({ sid: 'receipt-1', sub: '100', room: '9' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${body}.signature`;
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
const engines: TauriMediaEngine[] = [];

const SCREEN = {
  streamId: 'stream:300:screen', trackId: 'screen', publisherUserId: '300', kind: 'video', codec: 'vp9',
  layers: [
    { layerId: 0, ssrc: 41, width: 640, height: 360, maxBitrateKbps: 500, active: true },
    { layerId: 1, ssrc: 42, width: 1920, height: 1080, maxBitrateKbps: 4000, active: true },
  ],
};

beforeEach(() => {
  ipc.renderers.length = 0;
  ipc.tiles.length = 0;
  ipc.attachSampler = null;
  ipc.underlay = false;
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  ipc.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'start_voice_session') return { connected: true };
    if (command === 'media_get_stream_capabilities') {
      return { video: [], nativeDesktopRenderer: true, nativeRenderUnderlay: ipc.underlay, browserInteropProtocolV1: true, realMediaE2ee: true, simulcastV1: true };
    }
    if (command === 'media_list_published_tracks') return [SCREEN];
    if (command === 'native_render_attach_sampler') return ipc.attachSampler ? ipc.attachSampler() : { surfaceId: 7 };
    return [];
  });
  ipc.listen.mockReset().mockImplementation(async () => vi.fn());
});
afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((value) => value.disconnect()));
  vi.unstubAllGlobals();
});

async function joined() {
  const media = new TauriMediaEngine();
  engines.push(media);
  await media.connect('https://media.example/media', token(), 'pin', {
    id: 'call', role: 'listen', signal: new AbortController().signal,
  });
  return media;
}

const calls = (command: string) =>
  ipc.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args as Record<string, unknown>);

describe('a frame tap on the native-surface route', () => {
  it('attaches a sampler and subscribes the lowest layer when no surface shows the track', async () => {
    const media = await joined();
    const tap = media.tapVideoFrames('300', 'screen', () => {});
    await flush();
    await expect(tap.route).resolves.toBe('native-surface');
    expect(calls('native_render_attach_sampler')).toEqual([
      { streamId: 'stream:300:screen', trackId: 'screen', ownerId: expect.any(String) },
    ]);
    expect(calls('media_register_track_subscription')).toEqual([
      {
        request: expect.objectContaining({ streamId: 'stream:300:screen', trackId: 'screen', requestedLayer: 0 }),
        ownerId: expect.any(String),
      },
    ]);
    // No toolkit surface: nothing is drawn, so no tile is made.
    expect(ipc.tiles).toEqual([]);

    tap.release();
    await flush();
    expect(calls('native_render_detach')).toEqual([{ surfaceId: 7, ownerId: expect.any(String) }]);
    expect(calls('media_unregister_track_subscription')).toEqual([
      { streamId: 'stream:300:screen', trackId: 'screen', ownerId: expect.any(String) },
    ]);
  });

  it('hands the track to a surface that comes to show it (the stage), detaching the sampler', async () => {
    const media = await joined();
    const tap = media.tapVideoFrames('300', 'screen', () => {});
    await flush();
    const releaseSurface = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
      preferredTrackId: 'screen',
    });
    await flush();
    expect(calls('native_render_detach')).toEqual([{ surfaceId: 7, ownerId: expect.any(String) }]);
    expect(ipc.tiles).toEqual([{ fit: undefined, anchor: undefined, trackId: 'screen', occlusion: true }]);
    releaseSurface();
    tap.release();
  });

  it('detaches a sampler whose attach was still in flight when the tap was released', async () => {
    let finish: (value: unknown) => void = () => {};
    ipc.attachSampler = () => new Promise((resolve) => { finish = resolve; });
    const media = await joined();
    const tap = media.tapVideoFrames('300', 'screen', () => {});
    await flush();
    expect(calls('native_render_attach_sampler')).toHaveLength(1);
    tap.release();
    await flush();
    finish({ surfaceId: 9 });
    await flush();
    expect(calls('native_render_detach')).toEqual([{ surfaceId: 9, ownerId: expect.any(String) }]);
  });

  it('says so, loudly, when the shell cannot attach a sampler', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    ipc.attachSampler = async () => { throw new Error('no sampler'); };
    const media = await joined();
    const tap = media.tapVideoFrames('300', 'screen', () => {});
    await flush();
    await expect(tap.route).resolves.toBe('native-surface');
    expect(error).toHaveBeenCalledWith(
      '[media] native_render_attach_sampler failed; the room cannot sample this stream',
      expect.objectContaining({ error: 'no sampler' }),
    );
    tap.release();
    error.mockRestore();
  });

  it('keeps the replacement surface subscribed when the old sampler attaches late', async () => {
    let finish: (value: unknown) => void = () => {};
    ipc.attachSampler = () => new Promise((resolve) => { finish = resolve; });
    const media = await joined();
    const tap = media.tapVideoFrames('300', 'screen', () => {});
    await flush();
    const releaseSurface = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
      preferredTrackId: 'screen',
    });
    await flush();
    expect(calls('media_register_track_subscription')).toHaveLength(2);
    finish({ surfaceId: 9 });
    await flush();
    expect(calls('native_render_detach')).toEqual([{ surfaceId: 9, ownerId: expect.any(String) }]);
    expect(calls('media_unregister_track_subscription')).toEqual([]);
    tap.release();
    releaseSurface();
  });
});
