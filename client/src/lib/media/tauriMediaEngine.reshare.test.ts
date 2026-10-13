import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A watched share that stops and starts again (stream audit B1,
// docs/design/index-checkpoints/stream-fix-v2.md). The new share comes with a
// new key; the watch must pick it up by itself: subscribe again when the track
// is published again, and, when packets keep failing to open, ask for the key
// again instead of freezing in silence.

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
import { TauriMediaEngine } from './tauriMediaEngine';

function token(claims: Record<string, unknown> = {}): string {
  const body = btoa(JSON.stringify({ sid: 'receipt-1', sub: '100', room: '9', ...claims }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${body}.signature`;
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
const engines: TauriMediaEngine[] = [];

const VINCENT = '200';
const STREAM = `stream:${VINCENT}:screen`;
function screenTrack() {
  return {
    streamId: STREAM, trackId: 'screen', publisherUserId: VINCENT, kind: 'video', codec: 'av1',
    layers: [0, 1, 2].map((layerId) => ({
      layerId, ssrc: 0x77_00 + layerId, width: 640 << layerId, height: 360 << layerId, maxBitrateKbps: 1000, active: layerId === 2,
    })),
  };
}
function screenAudioTrack() {
  return {
    streamId: STREAM, trackId: 'screen-audio', publisherUserId: VINCENT, kind: 'audio', codec: null,
    layers: [{ layerId: 0, ssrc: 0x5a5a01, width: null, height: null, maxBitrateKbps: 192, active: true }],
  };
}

beforeEach(() => {
  ipc.handlers.clear();
  ipc.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'start_voice_session') return { connected: true };
    // No native renderer in jsdom: the subscription is made, with no surface.
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
});

function registrations(): string[] {
  return ipc.invoke.mock.calls
    .filter(([name]) => name === 'media_register_track_subscription')
    .map(([, args]) => {
      const { request } = args as { request: { streamId: string; trackId: string } };
      return `${request.streamId}:${request.trackId}`;
    });
}

/** Sean's view session, watching Vincent's screen and its sound. */
async function watching() {
  const media = new TauriMediaEngine();
  engines.push(media);
  await media.connect('https://media.example/media', token({ view: 'watch' }), 'pin', {
    id: 'view', role: 'view', signal: new AbortController().signal,
  });
  const emit = (event: string, payload: unknown) =>
    ipc.handlers.get(`${event}:${media.sessionOwnerId}`)!({ payload });
  media.subscribeScreenShareAudio(VINCENT, () => 1);
  await flush();
  emit('media_track_publish', screenTrack());
  emit('media_track_publish', screenAudioTrack());
  media.subscribeVideo(VINCENT, document.createElement('canvas'), undefined, { preferredTrackId: 'screen' });
  await vi.waitFor(() => expect(registrations()).toContain(`${STREAM}:screen-audio`));
  // The video subscription settles asynchronously (capabilities, then the route).
  await flush();
  return { media, emit };
}

describe('a watched share that stops and starts again', () => {
  it('subscribes again when the share is published again', async () => {
    const { emit } = await watching();
    ipc.invoke.mockClear();
    emit('media_track_unpublish', { streamId: STREAM, trackId: 'screen' });
    emit('media_track_publish', screenTrack());
    await flush();
    expect(registrations()).toContain(`${STREAM}:screen`);
  });

  it('asks for the key again when a watched track keeps failing to decrypt for want of one', async () => {
    const { emit } = await watching();
    ipc.invoke.mockClear();
    // The native side names the video track it knows the SSRC of.
    emit('media_decrypt_failing', {
      ssrc: 0x7701, epoch: 2, reason: 'no-key', keyProblem: true, streamId: STREAM, trackId: 'screen', consecutiveFailures: 50,
    });
    // An audio SSRC carries no track name: it is found among the published tracks.
    emit('media_decrypt_failing', {
      ssrc: 0x5a5a01, epoch: 2, reason: 'wrong-key', keyProblem: true, streamId: null, trackId: null, consecutiveFailures: 50,
    });
    await flush();
    expect(registrations().sort()).toEqual([`${STREAM}:screen`, `${STREAM}:screen-audio`]);
  });

  it('asks for nothing when the failure is not a key problem or the SSRC is nobody it watches', async () => {
    const { emit } = await watching();
    ipc.invoke.mockClear();
    emit('media_decrypt_failing', {
      ssrc: 0x7701, epoch: 2, reason: 'replay', keyProblem: false, streamId: STREAM, trackId: 'screen', consecutiveFailures: 50,
    });
    emit('media_decrypt_failing', { ssrc: 0xdead, epoch: 1, reason: 'no-key', keyProblem: true, consecutiveFailures: 50 });
    emit('media_decrypt_failing', { ssrc: 'nope' });
    await flush();
    expect(registrations()).toEqual([]);
  });
});
