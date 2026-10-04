import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop app has one video route (docs/glass-spec.md §2): every remote
// video and the self-view are decoded natively and drawn on a platform surface
// under the webview. No probe, no WebCodecs, no frame over IPC. A window with
// no renderer has no route at all and says so. A tap with no surface showing
// the track attaches a sampler so the track is decoded for its stills.

type TileOptions = {
  fit?: string;
  anchor?: unknown;
  trackId: string;
  occlusion?: unknown;
  listenShown?: (surfaceId: number, onShown: (generation: number) => void) => () => void;
  onVisibilityChange?: (visible: boolean) => void;
  onActiveChange?: (active: boolean) => void;
  readStill?: (maxWidth: number, maxHeight: number) => Promise<ImageBitmap | null>;
};

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  tiles: [] as TileOptions[],
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  renderer: true as boolean,
  attachSampler: null as null | (() => Promise<unknown>),
  still: null as null | Uint8Array,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('./video/nativeVideoTile', () => ({
  NativeVideoTile: class {
    constructor(readonly options: TileOptions) {
      ipc.tiles.push(options);
    }
    attach() {
      return Promise.resolve(11);
    }
    refreshPoster() {}
    destroy() {}
  },
}));
import { TauriMediaEngine } from './tauriMediaEngine';

function token(): string {
  const body = btoa(JSON.stringify({ sid: 'receipt-1', sub: '100', room: '9' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${body}.signature`;
}
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
const engines: TauriMediaEngine[] = [];

const SCREEN = {
  streamId: 'stream:300:screen', trackId: 'screen', publisherUserId: '300', kind: 'video', codec: 'vp9',
  layers: [
    { layerId: 0, ssrc: 41, width: 640, height: 360, maxBitrateKbps: 500, active: true },
    { layerId: 1, ssrc: 42, width: 1920, height: 1080, maxBitrateKbps: 4000, active: true },
  ],
};
const CAMERA = {
  streamId: 'stream:300:camera', trackId: 'camera', publisherUserId: '300', kind: 'video', codec: 'h264',
  layers: [{ layerId: 0, ssrc: 31, width: 640, height: 360, maxBitrateKbps: 800, active: true }],
};

beforeEach(() => {
  ipc.tiles.length = 0;
  ipc.handlers.clear();
  ipc.renderer = true;
  ipc.attachSampler = null;
  ipc.still = null;
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  ipc.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'start_voice_session') return { connected: true };
    if (command === 'media_get_stream_capabilities') {
      return ipc.renderer
        ? { video: [], nativeDesktopRenderer: true, nativeRenderUnderlay: true, browserInteropProtocolV1: true, realMediaE2ee: true, simulcastV1: true }
        : {
          video: [], nativeDesktopRenderer: false, nativeRenderUnderlay: false,
          nativeRendererError: 'no usable GL context for the video underlay',
          browserInteropProtocolV1: true, realMediaE2ee: true, simulcastV1: true,
        };
    }
    if (command === 'media_list_published_tracks') return [SCREEN, CAMERA];
    if (command === 'native_render_attach_sampler') return ipc.attachSampler ? ipc.attachSampler() : { surfaceId: 7 };
    if (command === 'native_render_still') return ipc.still?.buffer ?? new Uint8Array([1]).buffer;
    return [];
  });
  ipc.listen.mockReset().mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
    ipc.handlers.set(name, handler);
    return vi.fn();
  });
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

describe('the desktop video route', () => {
  it('draws every subscribed track on a native surface, never in the page', async () => {
    const media = await joined();
    const tap = media.tapVideoFrames('300', 'screen', () => {});
    const releaseScreen = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
      preferredTrackId: 'screen',
    });
    await flush();
    await expect(tap.route).resolves.toBe('native-surface');
    expect(ipc.tiles.map((tile) => tile.trackId)).toEqual(['screen']);
    // Nothing is decoded in the page: no channel, no probe, no WebCodecs.
    const commands = ipc.invoke.mock.calls.map(([name]) => name);
    expect(commands).not.toContain('media_register_stream_video_subscription');
    expect(commands).not.toContain('media_generate_decode_probe');
    releaseScreen();
    tap.release();
  });

  it('places the picture as the tile asks: contain by default, cover around an anchor for cameras', async () => {
    const media = await joined();
    const releaseCover = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
      preferredTrackId: 'camera', fit: 'cover', anchor: { x: 0.5, y: 0.35 },
    });
    const releaseDefault = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
      preferredTrackId: 'screen',
    });
    await flush();
    expect(ipc.tiles.map(({ fit, anchor, trackId }) => ({ fit, anchor, trackId }))).toEqual([
      { fit: 'cover', anchor: { x: 0.5, y: 0.35 }, trackId: 'camera' },
      { fit: undefined, anchor: undefined, trackId: 'screen' },
    ]);
    releaseCover();
    releaseDefault();
  });

  it('has no route, and says why, in a window whose renderer did not install', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    ipc.renderer = false;
    const media = await joined();
    const tap = media.tapVideoFrames('300', 'screen', () => {});
    await flush();
    await expect(tap.route).resolves.toBe('no-route');
    expect(ipc.tiles).toEqual([]);
    expect(calls('native_render_attach_sampler')).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      "[media] cannot show 300's screen: no usable GL context for the video underlay",
    );
    tap.release();
    error.mockRestore();
  });

  it('opens the hole only on the native side confirming the reveal, and pauses decoding only when told', async () => {
    const media = await joined();
    const canvas = document.createElement('canvas');
    const holes: boolean[] = [];
    canvas.addEventListener('paracord:native-surface-visibility', (event) => {
      holes.push(Boolean((event as CustomEvent<{ visible?: boolean }>).detail?.visible));
    });
    const release = media.subscribeVideo('300', canvas, undefined, { preferredTrackId: 'screen' });
    await flush();
    const tile = ipc.tiles[0];
    // The engine routes `native_render_shown` for this surface to the tile.
    const shown = vi.fn();
    tile.listenShown?.(11, shown);
    ipc.handlers.get(`native_render_shown:${media.sessionOwnerId}`)?.({ payload: { surfaceId: 11, generation: 3 } });
    expect(shown).toHaveBeenCalledWith(3);
    ipc.handlers.get(`native_render_shown:${media.sessionOwnerId}`)?.({ payload: { surfaceId: 12, generation: 4 } });
    expect(shown).toHaveBeenCalledTimes(1);
    // The tile's verdicts reach the page and the decoder.
    tile.onVisibilityChange?.(true);
    tile.onVisibilityChange?.(false);
    expect(holes).toEqual([true, false]);
    tile.onActiveChange?.(false);
    await flush();
    expect(calls('media_set_stream_visibility')).toEqual([
      { streamId: 'stream:300:screen', trackId: 'screen', visible: false, ownerId: expect.any(String) },
    ]);
    release();
  });

  it('reads a still of the track for the poster, in binary', async () => {
    const created: Array<{ width: number; height: number }> = [];
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    vi.stubGlobal('createImageBitmap', async (data: { width: number; height: number }) => {
      created.push({ width: data.width, height: data.height });
      return { width: data.width, height: data.height, close() {} };
    });
    const still = new Uint8Array(20 + 2 * 1 * 4);
    const view = new DataView(still.buffer);
    still[0] = 2;
    view.setUint32(4, 2, true);
    view.setUint32(8, 1, true);
    view.setBigUint64(12, 5n, true);
    ipc.still = still;
    const media = await joined();
    const release = media.subscribeVideo('300', document.createElement('canvas'), undefined, { preferredTrackId: 'screen' });
    await flush();
    const bitmap = await ipc.tiles[0].readStill?.(960, 540);
    expect(bitmap).toMatchObject({ width: 2, height: 1 });
    expect(calls('native_render_still').at(-1)).toEqual({
      streamId: 'stream:300:screen', trackId: 'screen', maxWidth: 960, maxHeight: 540, afterSeq: null,
    });
    // A sampler skips a still it has already: `unchanged` is no still at all.
    ipc.still = new Uint8Array([3]);
    await expect(media.readVideoStill('300', 'screen', 64, 36, 5)).resolves.toBeNull();
    expect(created).toEqual([{ width: 2, height: 1 }]);
    release();
  });
});

describe('a frame tap with no surface showing the track', () => {
  it('attaches a sampler and subscribes the lowest layer', async () => {
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
    expect(ipc.tiles.map((tile) => tile.trackId)).toEqual(['screen']);
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
      '[media] native_render_attach_sampler failed; nothing can sample this stream',
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

it('upload feedback does not downgrade a watched video on a healthy downlink', async () => {
  const base = ipc.invoke.getMockImplementation()!;
  ipc.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'media_list_published_tracks') return [{ ...CAMERA, layers: [
      ...CAMERA.layers, { layerId: 2, ssrc: 33, width: 1920, height: 1080, maxBitrateKbps: 12000, active: true },
    ] }];
    return base(command, ...args);
  });
  const media = await joined();
  const canvas = document.createElement('canvas');
  Object.defineProperties(canvas, { clientWidth: { value: 1920 }, clientHeight: { value: 1080 } });
  const release = media.subscribeVideo('300', canvas, undefined, { preferredTrackId: 'camera' });
  await flush();
  expect(ipc.invoke.mock.calls.some(([name]) => name === 'media_register_track_subscription')).toBe(true);
  ipc.invoke.mockClear();
  ipc.handlers.get(`media_bandwidth_feedback:${media.sessionOwnerId}`)?.({ payload: { availableKbps: 512 } });
  await flush();
  expect(ipc.invoke.mock.calls.filter(([name]) => name === 'media_register_track_subscription')).toEqual([]);
  release();
});
