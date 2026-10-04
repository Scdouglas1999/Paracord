import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// On the desktop the stream's own audio plays in the native mixer, but the
// relay subscription that brings it is still sent from here. A watch goes live
// before the relay has described the sharer's `screen-audio` track, so the
// subscription is sent when that track's publish arrives
// (docs/design/glass-fix-watch-audio.md).

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('./video/canvasRenderer', () => ({
  CanvasRenderer: class {
    constructor(readonly canvasElement: HTMLCanvasElement) {}
    setRenderingEnabled() {}
    renderFrame(frame: { close(): void }) { frame.close(); }
    destroy() {}
  },
}));
import { TauriMediaEngine } from './tauriMediaEngine';

function token(claims: Record<string, unknown> = {}): string {
  const body = btoa(JSON.stringify({ sid: 'receipt-1', sub: '100', room: '9', ...claims }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${body}.signature`;
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const engines: TauriMediaEngine[] = [];

const VINCENT = '200';
const STREAM = `stream:${VINCENT}:screen`;
function screenAudioTrack(ssrc = 0x5a5a01) {
  return {
    streamId: STREAM, trackId: 'screen-audio', publisherUserId: VINCENT, kind: 'audio', codec: null,
    layers: [{ layerId: 0, ssrc, width: null, height: null, maxBitrateKbps: 192, active: true }],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  ipc.handlers.clear();
  ipc.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'start_voice_session') return { connected: true };
    if (command === 'media_get_stream_capabilities') return { video: [], nativeDesktopRenderer: false, browserInteropProtocolV1: true, realMediaE2ee: true, simulcastV1: true };
    return [];
  });
  ipc.listen.mockReset().mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    ipc.handlers.set(event, handler);
    return vi.fn();
  });
});
afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((value) => value.disconnect()));
  vi.useRealTimers();
});

function subscriptions(command: 'media_register_track_subscription' | 'media_unregister_track_subscription') {
  return ipc.invoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => {
      const request = (args as { request?: { streamId: string; trackId: string }; streamId?: string; trackId?: string });
      const target = request.request ?? request;
      return `${target.streamId}:${target.trackId}`;
    });
}

/** Sean's view session watching Vincent, live before any track is known. */
async function watching() {
  const media = new TauriMediaEngine();
  engines.push(media);
  await media.connect('https://media.example/media', token({ view: 'watch' }), 'pin', {
    id: 'view', role: 'view', signal: new AbortController().signal,
  });
  const release = media.subscribeScreenShareAudio(VINCENT, () => 1);
  await flush();
  const publish = (track: unknown) => ipc.handlers.get(`media_track_publish:${media.sessionOwnerId}`)!({ payload: track });
  return { media, release, publish };
}

describe('a desktop watch that goes live before the stream audio is published', () => {
  it('subscribes to the stream audio when its publish arrives', async () => {
    const { publish } = await watching();
    expect(subscriptions('media_register_track_subscription')).toEqual([]);

    publish(screenAudioTrack());
    await flush();
    expect(subscriptions('media_register_track_subscription')).toEqual([`${STREAM}:screen-audio`]);
  });

  it('leaves an unchanged repeat alone, renews on a change, and unsubscribes on release', async () => {
    const { publish, release } = await watching();
    publish(screenAudioTrack());
    publish(screenAudioTrack());
    await flush();
    expect(subscriptions('media_register_track_subscription')).toEqual([`${STREAM}:screen-audio`]);

    publish(screenAudioTrack(0x5a5a02));
    await flush();
    expect(subscriptions('media_register_track_subscription')).toHaveLength(2);

    release();
    await flush();
    expect(subscriptions('media_unregister_track_subscription')).toEqual([`${STREAM}:screen-audio`]);
    publish(screenAudioTrack(0x5a5a03));
    await flush();
    expect(subscriptions('media_register_track_subscription')).toHaveLength(2);
  });

  it('asks for nothing but the stream audio (never the camera, never a voice)', async () => {
    const { publish } = await watching();
    publish({
      streamId: `stream:${VINCENT}:camera`, trackId: 'camera', publisherUserId: VINCENT, kind: 'video', codec: 'vp9',
      layers: [{ layerId: 0, ssrc: 9, width: 640, height: 360, maxBitrateKbps: 800, active: true }],
    });
    publish(screenAudioTrack());
    await flush();
    expect(subscriptions('media_register_track_subscription')).toEqual([`${STREAM}:screen-audio`]);
  });
});

describe('live desktop sharing quality', () => {
  it('updates the owned encoder without reopening capture or interrupting audio', async () => {
    const media = new TauriMediaEngine();
    engines.push(media);
    await media.connect('https://media.example/media', token(), 'pin', {
      id: 'call', role: 'call', signal: new AbortController().signal,
    });
    ipc.invoke.mockClear();
    await media.updateScreenShareQuality({ audio: true, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: 12000000, contentHint: 'detail' });
    expect(ipc.invoke).toHaveBeenCalledWith('screen_share_set_quality', expect.objectContaining({
      ownerId: media.sessionOwnerId,
      request: expect.objectContaining({ maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: 12000000 }),
    }));
    expect(ipc.invoke.mock.calls.map(([name]) => name)).not.toContain('screen_share_start');
    expect(ipc.invoke.mock.calls.map(([name]) => name)).not.toContain('screen_share_stop');
  });
});
