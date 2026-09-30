import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./video/canvasRenderer', () => ({
  CanvasRenderer: class {
    constructor(readonly canvasElement: HTMLCanvasElement) {}
    setRenderingEnabled() {}
    renderFrame(frame: { close(): void }) { frame.close(); }
    destroy() {}
  },
}));
vi.mock('./video/videoDecoder', () => ({
  MediaVideoDecoder: class {
    constructor(readonly config: { codec: string }) {}
    onDecoded() {}
    onError() {}
    onKeyframeNeeded() {}
    decode() {}
    reset() {}
    close() {}
  },
}));

import { BrowserMediaEngine } from './browserMediaEngine';
import { MediaKeyring } from './mediaKeyring';
import { WebTransportManager } from './transport/webTransport';
import { createPacket, TrackType, PROTOCOL_VERSION, type MediaHeader } from './transport/protocol';
import { deriveTrackSsrc } from './engineShared';

// Watching without joining plays the stream's own audio (plan §8: Watch = the
// stream's video AND its own audio, never the voices). The watch goes live
// before the relay has described the sharer's `screen-audio` track, so the
// subscription has to be sent when that track's publish arrives
// (docs/design/glass-fix-watch-audio.md).

function token(claims: Record<string, unknown>): string {
  const body = btoa(JSON.stringify({ sid: 'receipt-1', sub: '100', room: '9', ...claims }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${body}.signature`;
}

class FakeAudioContext {
  audioWorklet = { addModule: vi.fn(async () => {}) };
  destination = {};
  createMediaStreamSource() { return { connect: vi.fn() }; }
  createGain() { return { gain: { value: 1 }, connect: vi.fn() }; }
  createBuffer() { return { copyToChannel: vi.fn() }; }
  createBufferSource() { return { connect: vi.fn(), start: vi.fn() }; }
  close() { return Promise.resolve(); }
}

function stubMedia() {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', class { port = { onmessage: null }; connect() {} disconnect() {} });
  vi.stubGlobal('AudioEncoder', class { configure() {} encode() {} close() {} static isConfigSupported = async () => ({ supported: true }); });
  vi.stubGlobal('AudioDecoder', class { configure() {} decode() {} close() {} });
}

function stubTransport() {
  const sent: Array<Record<string, unknown>> = [];
  vi.spyOn(WebTransportManager.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(WebTransportManager.prototype, 'setTerminalCloseReasons');
  vi.spyOn(WebTransportManager.prototype, 'sendStreamControl').mockImplementation(async (message) => {
    sent.push(message as Record<string, unknown>);
  });
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Internals {
  handleStreamControlMessage(message: Record<string, unknown>): void;
  handleDatagram(data: Uint8Array): void;
  screenAudioSubscriptions: Map<string, { ssrc: number }>;
  participants: Map<number, unknown>;
  participantMaterializePromises: Map<string, unknown>;
  orphanAudioPackets: Map<number, unknown>;
}

const VINCENT = '200';
const STREAM = `stream:${VINCENT}:screen`;
const SCREEN_AUDIO_SSRC = 0x5a5a01;

function screenTrack() {
  return {
    streamId: STREAM, trackId: 'screen', publisherUserId: VINCENT, kind: 'video', codec: 'vp9',
    layers: [{ layerId: 0, ssrc: 0x5a5a00, width: 640, height: 360, maxBitrateKbps: 2000, active: true }],
  };
}
function screenAudioTrack(ssrc = SCREEN_AUDIO_SSRC) {
  return {
    streamId: STREAM, trackId: 'screen-audio', publisherUserId: VINCENT, kind: 'audio', codec: null,
    layers: [{ layerId: 0, ssrc, width: null, height: null, maxBitrateKbps: 192, active: true }],
  };
}

function subscriptionsSent(sent: Array<Record<string, unknown>>) {
  return sent
    .filter((message) => message.type === 'subscribe_stream')
    .map((message) => {
      const subscription = message.subscription as { streamId: string; trackId: string };
      return `${subscription.streamId}:${subscription.trackId}`;
    });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Sean's view session watching Vincent, live before any track is known. */
async function watching() {
  stubMedia();
  const sent = stubTransport();
  const engine = new BrowserMediaEngine();
  await engine.connect('https://media.test', token({ view: 'watch' }), 'pin', {
    id: 'view', role: 'view', signal: new AbortController().signal,
  });
  const internals = engine as unknown as Internals;
  internals.handleStreamControlMessage({
    type: 'session_state',
    participants: [{ userId: VINCENT, sessionId: 'r-200', videoCapabilities: [], mediaPublicKey: MediaKeyring.create().publicKey, kind: 'member' }],
  });
  // What `viewSessions.attach` does the moment the view is live.
  const release = engine.subscribeScreenShareAudio(VINCENT, () => 1);
  await settle();
  return { engine, internals, sent, release };
}

describe('a watch that goes live before the stream audio is published', () => {
  it('subscribes to the stream audio when its publish arrives', async () => {
    const { engine, internals, sent } = await watching();
    // Nothing known yet, so nothing can be asked for.
    expect(subscriptionsSent(sent)).toEqual([]);

    internals.handleStreamControlMessage({ type: 'track_publish', track: screenTrack() });
    internals.handleStreamControlMessage({ type: 'track_publish', track: screenAudioTrack() });
    await settle();

    expect(subscriptionsSent(sent)).toEqual([`${STREAM}:screen-audio`]);
    // Packets are matched to the watched stream by the published SSRC.
    expect(internals.screenAudioSubscriptions.get(VINCENT)?.ssrc).toBe(SCREEN_AUDIO_SSRC);
    await engine.disconnect();
  });

  it('does not re-subscribe on an unchanged repeat, and does on a changed one', async () => {
    const { engine, internals, sent } = await watching();
    internals.handleStreamControlMessage({ type: 'track_publish', track: screenAudioTrack() });
    // The relay repeats a track's publish after every key announce for it.
    internals.handleStreamControlMessage({ type: 'track_publish', track: screenAudioTrack() });
    await settle();
    expect(subscriptionsSent(sent)).toEqual([`${STREAM}:screen-audio`]);

    // The sharer restarted the stream audio on a new SSRC.
    internals.handleStreamControlMessage({ type: 'track_publish', track: screenAudioTrack(0x5a5a02) });
    await settle();
    expect(subscriptionsSent(sent)).toEqual([`${STREAM}:screen-audio`, `${STREAM}:screen-audio`]);
    expect(internals.screenAudioSubscriptions.get(VINCENT)?.ssrc).toBe(0x5a5a02);
    await engine.disconnect();
  });

  it('subscribes to nothing once the watch has stopped listening', async () => {
    const { engine, internals, sent, release } = await watching();
    release();
    internals.handleStreamControlMessage({ type: 'track_publish', track: screenAudioTrack() });
    await settle();
    expect(subscriptionsSent(sent)).toEqual([]);
    await engine.disconnect();
  });

  it('never subscribes to or plays a voice', async () => {
    const { engine, internals, sent } = await watching();
    internals.handleStreamControlMessage({ type: 'track_publish', track: screenAudioTrack() });
    // Vincent's camera is not the stream either.
    internals.handleStreamControlMessage({
      type: 'track_publish',
      track: { ...screenTrack(), streamId: `stream:${VINCENT}:camera`, trackId: 'camera' },
    });
    await settle();
    expect(subscriptionsSent(sent)).toEqual([`${STREAM}:screen-audio`]);

    // A voice packet from Vincent (his derived voice SSRC) is dropped: no
    // participant is made for it and nothing is held for later.
    const voiceSsrc = await deriveTrackSsrc(VINCENT, 'audio');
    const header: MediaHeader = {
      version: PROTOCOL_VERSION, trackType: TrackType.Audio, simulcastLayer: 0, sequence: 1,
      timestamp: 20, ssrc: voiceSsrc, audioLevel: 40, keyEpoch: 0, payloadLength: 0, codec: 0,
    };
    internals.handleDatagram(createPacket(header, new Uint8Array(40)));
    await settle();
    expect(internals.participants.size).toBe(0);
    expect(internals.participantMaterializePromises.size).toBe(0);
    expect(internals.orphanAudioPackets.size).toBe(0);
    await engine.disconnect();
  });

  it('keeps a bare video subscription on its video when the stream audio is published', async () => {
    const { engine, internals } = await watching();
    internals.handleStreamControlMessage({ type: 'track_publish', track: screenTrack() });
    const canvas = document.createElement('canvas');
    const release = engine.subscribeVideo(VINCENT, canvas);
    const subs = (engine as unknown as { videoSubscriptions: Map<string, { ssrc: number; trackId?: string }> }).videoSubscriptions;
    const before = subs.get(VINCENT);
    expect(before?.trackId).toBe('screen');
    internals.handleStreamControlMessage({ type: 'track_publish', track: screenAudioTrack() });
    await settle();
    expect(subs.get(VINCENT)?.trackId).toBe('screen');
    expect(subs.get(VINCENT)?.ssrc).toBe(0x5a5a00);
    release();
    await engine.disconnect();
  });
});
