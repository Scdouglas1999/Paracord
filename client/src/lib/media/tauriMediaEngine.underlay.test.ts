import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// On Linux the native surface is drawn under the webview. Its tile samples
// occlusion in `'underlay'` mode: only a marked occluder over its center (a
// stage move's shield, a dialog, a menu) hides it, and the body observer that
// mode installs re-reports the settled box when the shield comes off (WP-G23).

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  renderers: [] as Array<{ fit?: string; anchor?: unknown }>,
  tiles: [] as Array<{ fit?: string; anchor?: unknown; trackId: string; occlusion?: unknown }>,
  underlay: true,
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
  ipc.underlay = true;
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

describe('a native surface under the webview (Linux)', () => {
  it("samples occlusion in underlay mode, so a stage move's shield hides it and its end re-reports the box", async () => {
    ipc.underlay = true;
    const media = await joined();
    const release = media.subscribeVideo('300', document.createElement('canvas'), undefined, { preferredTrackId: 'screen' });
    await flush();
    expect(ipc.tiles.map((tile) => tile.occlusion)).toEqual(['underlay']);
    release();
  });
});
