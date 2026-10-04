import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A surface's `fit` (contain or cover) and the `anchor` of a cover crop reach
// whatever draws it on the desktop: the canvas renderer on the WebCodecs route,
// and the native surface on the native-surface route (glass-polish-1 item 7;
// camera tiles cover, glass-polish-2 item 2: around the upper third).

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  renderers: [] as Array<{ fit?: string; anchor?: unknown }>,
  tiles: [] as Array<{ fit?: string; anchor?: unknown; trackId: string }>,
  webCodecs: true,
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
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
    constructor(options: { fit?: string; anchor?: unknown; trackId: string }) {
      ipc.tiles.push({ fit: options.fit, anchor: options.anchor, trackId: options.trackId });
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

const CAMERA = {
  streamId: 'stream:300:camera', trackId: 'camera', publisherUserId: '300', kind: 'video', codec: 'vp9',
  layers: [{ layerId: 0, ssrc: 31, width: 640, height: 360, maxBitrateKbps: 800, active: true }],
};

beforeEach(() => {
  ipc.handlers.clear();
  ipc.renderers.length = 0;
  ipc.tiles.length = 0;
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  ipc.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'start_voice_session') return { connected: true };
    if (command === 'media_get_stream_capabilities') {
      return { video: [], nativeDesktopRenderer: true, nativeRenderUnderlay: false, browserInteropProtocolV1: true, realMediaE2ee: true, simulcastV1: true };
    }
    if (command === 'media_list_published_tracks') return [CAMERA];
    return [];
  });
  ipc.listen.mockReset().mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => { ipc.handlers.set(name, handler); return vi.fn(); });
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

describe('the fit of a desktop video surface', () => {
  it('reaches the canvas renderer (cover when asked, contain by default)', async () => {
    const media = await joined();
    const releaseCover = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
      preferredTrackId: 'camera', fit: 'cover',
    });
    await flush();
    const releaseDefault = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
      preferredTrackId: 'screen',
    });
    await flush();
    expect(ipc.renderers.map((renderer) => renderer.fit)).toEqual(['cover', undefined]);
    releaseCover();
    releaseDefault();
  });

  it('hands a cover anchor to the canvas renderer', async () => {
    const media = await joined();
    const release = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
      preferredTrackId: 'camera', fit: 'cover', anchor: { x: 0.5, y: 0.35 },
    });
    await flush();
    expect(ipc.renderers).toEqual([{ fit: 'cover', anchor: { x: 0.5, y: 0.35 } }]);
    release();
  });

  it('hands a cover anchor to the native surface on the native-surface route', async () => {
    ipc.webCodecs = false;
    try {
      const media = await joined();
      const release = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
        preferredTrackId: 'camera', fit: 'cover', anchor: { x: 0.5, y: 0.35 },
      });
      await flush();
      expect(ipc.tiles).toEqual([{ fit: 'cover', anchor: { x: 0.5, y: 0.35 }, trackId: 'camera' }]);
      release();
    } finally {
      ipc.webCodecs = true;
    }
  });

  it('reaches the native surface on the native-surface route', async () => {
    ipc.webCodecs = false;
    try {
      const media = await joined();
      const release = media.subscribeVideo('300', document.createElement('canvas'), undefined, {
        preferredTrackId: 'camera', fit: 'cover',
      });
      await flush();
      expect(ipc.tiles).toEqual([{ fit: 'cover', trackId: 'camera' }]);
      release();
    } finally {
      ipc.webCodecs = true;
    }
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
