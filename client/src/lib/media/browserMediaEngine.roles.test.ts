import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserMediaEngine } from './browserMediaEngine';
import { MediaKeyring } from './mediaKeyring';
import { WebTransportManager } from './transport/webTransport';
import type { SenderKeyManager } from './senderKeys';

// Listen, view and the publisher's view of viewers (docs/design/glass-g6-checkpoint.md).

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
  close() { return Promise.resolve(); }
}

function stubMedia() {
  const getUserMedia = vi.fn(async () => ({
    getAudioTracks: () => [{ enabled: true }],
    getTracks: () => [{ stop: vi.fn() }],
  }) as unknown as MediaStream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', class { port = { onmessage: null }; connect() {} disconnect() {} });
  vi.stubGlobal('AudioEncoder', class { configure() {} encode() {} close() {} static isConfigSupported = async () => ({ supported: true }); });
  vi.stubGlobal('AudioDecoder', class { configure() {} decode() {} close() {} });
  return getUserMedia;
}

function stubTransport() {
  const sent: Array<Record<string, unknown>> = [];
  const connect = vi.spyOn(WebTransportManager.prototype, 'connect').mockResolvedValue(undefined);
  const send = vi.spyOn(WebTransportManager.prototype, 'sendStreamControl').mockImplementation(async (message) => {
    sent.push(message as Record<string, unknown>);
  });
  const terminal = vi.spyOn(WebTransportManager.prototype, 'setTerminalCloseReasons');
  return { sent, connect, send, terminal };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a listening engine', () => {
  it('connects without ever asking for the microphone, and opens it on the upgrade', async () => {
    const getUserMedia = stubMedia();
    const { connect, sent } = stubTransport();
    const engine = new BrowserMediaEngine();
    await engine.connect('https://media.test', token({}), 'pin', {
      id: 'call', role: 'listen', signal: new AbortController().signal,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sent[0]?.type).toBe('session_join');
    expect(getUserMedia).not.toHaveBeenCalled();

    await engine.startMicrophone();
    // Same connection: no second transport connect, only the capture opened.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // A second start is a no-op now that the engine is a joined member.
    await engine.startMicrophone();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await engine.disconnect();
  });

  it('a joined engine opens the microphone at connect, as before', async () => {
    const getUserMedia = stubMedia();
    stubTransport();
    const engine = new BrowserMediaEngine();
    await engine.connect('https://media.test', token({}), 'pin', { id: 'call', signal: new AbortController().signal });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await engine.disconnect();
  });
});

describe('a view-session engine', () => {
  it('refuses a call token as a view and a view token as a call', async () => {
    stubMedia();
    stubTransport();
    await expect(new BrowserMediaEngine().connect('https://media.test', token({}), 'pin', {
      id: 'view', role: 'view', signal: new AbortController().signal,
    })).rejects.toThrow(/view-session media token/);
    await expect(new BrowserMediaEngine().connect('https://media.test', token({ view: 'watch' }), 'pin', {
      id: 'call', signal: new AbortController().signal,
    })).rejects.toThrow(/cannot join a call/);
  });

  it('never captures, never announces a key, and never reconnects after a superseded close', async () => {
    const getUserMedia = stubMedia();
    const { sent, terminal } = stubTransport();
    const engine = new BrowserMediaEngine();
    await engine.connect('https://media.test', token({ view: 'ambient' }), 'pin', {
      id: 'view', role: 'view', signal: new AbortController().signal,
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    const isTerminal = terminal.mock.calls[0]?.[0] as (reason: string) => boolean;
    expect(isTerminal('superseded by a newer media connection')).toBe(true);
    expect(isTerminal('view session ended')).toBe(true);
    expect(isTerminal('Connection lost')).toBe(false);

    const vincent = MediaKeyring.create();
    (engine as unknown as { handleStreamControlMessage(message: Record<string, unknown>): void })
      .handleStreamControlMessage({
        type: 'session_state',
        participants: [{ userId: '200', sessionId: 'r-200', videoCapabilities: [], mediaPublicKey: vincent.publicKey }],
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.map((message) => message.type)).toEqual(['session_join']);
    await engine.disconnect();
  });
});

interface Internals {
  localUserId: string | null;
  localRoomId: string | null;
  membershipSessionId: string | null;
  account: { assertCurrent(): void } | undefined;
  transport: { sendStreamControl: (message: unknown) => Promise<void>; disconnect: () => Promise<void> } | null;
  senderKeys: SenderKeyManager;
  trackSenders?: Map<string, SenderKeyManager>;
  freshLocalTrackKey?: (trackId: 'camera' | 'screen' | 'screen-audio') => Promise<void>;
  handleStreamControlMessage(message: Record<string, unknown>): void;
  materializeRemoteParticipant(userId: string): Promise<void>;
  publishedTracks: Map<string, unknown>;
}

const SELF = '100';
const ROOM = '9';
const SCREEN_STREAM = `stream:${SELF}:screen`;
const CAMERA_STREAM = `stream:${SELF}:camera`;

async function publisher() {
  const engine = new BrowserMediaEngine();
  const internals = engine as unknown as Internals;
  internals.localUserId = SELF;
  internals.localRoomId = ROOM;
  internals.membershipSessionId = 'receipt-self';
  internals.account = { assertCurrent: () => {} };
  const sent: Array<Record<string, unknown>> = [];
  internals.transport = { sendStreamControl: async (m) => { sent.push(m as Record<string, unknown>); }, disconnect: async () => {} };
  vi.spyOn(internals, 'materializeRemoteParticipant').mockResolvedValue(undefined);
  await internals.senderKeys.generateKey();
  // Our own screen share (video and its own audio) and camera, so stream keys
  // have something to announce. Each track starts capturing with a key of its
  // own.
  for (const trackId of ['screen', 'screen-audio', 'camera'] as const) {
    await internals.freshLocalTrackKey?.(trackId);
  }
  internals.publishedTracks.set(`${SCREEN_STREAM}:screen`, {
    streamId: SCREEN_STREAM, trackId: 'screen', publisherUserId: SELF, kind: 'video', codec: 'vp9',
    layers: [{ layerId: 0, ssrc: 11, active: true }],
  });
  internals.publishedTracks.set(`${SCREEN_STREAM}:screen-audio`, {
    streamId: SCREEN_STREAM, trackId: 'screen-audio', publisherUserId: SELF, kind: 'audio',
    layers: [{ layerId: 0, ssrc: 12, active: true }],
  });
  internals.publishedTracks.set(`${CAMERA_STREAM}:camera`, {
    streamId: CAMERA_STREAM, trackId: 'camera', publisherUserId: SELF, kind: 'video', codec: 'vp9',
    layers: [{ layerId: 0, ssrc: 13, active: true }],
  });
  const joins: string[] = [];
  const leaves: string[] = [];
  engine.onParticipantJoin((id) => joins.push(id));
  engine.onParticipantLeave((id) => leaves.push(id));
  const lost = vi.fn();
  engine.onTransportLost(lost);
  return { engine, internals, sent, joins, leaves, lost };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

function entry(userId: string, sessionId: string, keyring: MediaKeyring, kind?: 'member' | 'viewer') {
  return { userId, sessionId, videoCapabilities: [], mediaPublicKey: keyring.publicKey, ...(kind ? { kind } : {}) };
}

function recipientsOf(message: Record<string, unknown>): string[] {
  return (message.encrypted_keys as Array<[string, number[]]>).map(([id]) => String(id));
}

function wrappedFor(message: Record<string, unknown>, recipient: string): Uint8Array {
  const found = (message.encrypted_keys as Array<[string, number[]]>).find(([id]) => String(id) === recipient);
  if (!found) throw new Error(`nothing wrapped for ${recipient}`);
  return Uint8Array.from(found[1]);
}

function trackAnnounces(sent: Array<Record<string, unknown>>, streamId: string, trackId: string) {
  return sent.filter((m) => m.type === 'stream_key_announce' && m.stream_id === streamId && m.track_id === trackId);
}

/** Brendan (a member) in the call, then Sean starts watching our screen. */
async function withMemberAndViewer() {
  const p = await publisher();
  const brendan = MediaKeyring.create();
  const sean = MediaKeyring.create();
  p.internals.handleStreamControlMessage({
    type: 'session_state',
    participants: [entry('300', 'r-300', brendan, 'member')],
  });
  await settle();
  const afterRoster = p.sent.length;
  p.internals.handleStreamControlMessage({
    type: 'session_participant_join',
    participant: entry('400', 'view-400', sean, 'viewer'),
  });
  await settle();
  return { ...p, brendan, sean, afterRoster };
}

describe('a publisher with a viewer in its roster (the relay marks it)', () => {
  it('never wraps the voice key for the viewer, and the stream key it gets does not open the voice', async () => {
    const p = await withMemberAndViewer();
    const afterViewer = p.sent.slice(p.afterRoster);
    for (const message of p.sent.filter((m) => m.type === 'key_announce')) {
      expect(recipientsOf(message), 'the voice key reached a viewer').not.toContain('400');
    }
    // The viewer is owed the watched stream's keys (video and its own audio),
    // wrapped to it alone, and nothing else.
    const screen = trackAnnounces(afterViewer, SCREEN_STREAM, 'screen');
    expect(screen.map(recipientsOf)).toEqual([['400']]);
    expect(trackAnnounces(afterViewer, SCREEN_STREAM, 'screen-audio').map(recipientsOf)).toEqual([['400']]);
    for (const message of trackAnnounces(p.sent, CAMERA_STREAM, 'camera')) {
      expect(recipientsOf(message), 'a camera key reached a viewer').not.toContain('400');
    }

    // What the viewer can open is the screen's key, and it is not the voice's.
    p.sean.setPeerKey(SELF, (p.engine as unknown as { keyring: MediaKeyring }).keyring.publicKey);
    const opened = await p.sean.unwrapSenderKey(`stream:${SCREEN_STREAM}:screen`, SELF, wrappedFor(screen[0], '400'));
    expect(opened?.rawKey.byteLength).toBe(16);
    const voiceKey = await p.internals.senderKeys.exportKey();
    expect(Array.from(opened!.rawKey)).not.toEqual(Array.from(voiceKey));
    // And the member holds a voice key the viewer does not.
    const voiceAnnounce = p.sent.filter((m) => m.type === 'key_announce').at(-1)!;
    expect(recipientsOf(voiceAnnounce)).toEqual(['300']);
    expect(p.lost).not.toHaveBeenCalled();
    await p.engine.disconnect();
  });

  it('does not report the viewer to the call, and its arrival and departure never rotate the voice key', async () => {
    const p = await withMemberAndViewer();
    expect(p.joins).toEqual(['300']);
    const voiceEpoch = p.internals.senderKeys.currentEpoch;
    const voiceKey = Array.from(await p.internals.senderKeys.exportKey());
    const screenEpoch = p.internals.trackSenders?.get(`${SCREEN_STREAM}:screen`)?.currentEpoch;

    p.sent.length = 0;
    p.internals.handleStreamControlMessage({ type: 'session_participant_leave', user_id: '400', session_id: 'view-400' });
    await settle();
    expect(p.leaves).toEqual([]);
    expect(p.internals.senderKeys.currentEpoch).toBe(voiceEpoch);
    expect(Array.from(await p.internals.senderKeys.exportKey())).toEqual(voiceKey);
    expect(p.sent.filter((m) => m.type === 'key_announce')).toEqual([]);
    // What the departed viewer could open rotates, and goes to the member only.
    expect(p.internals.trackSenders?.get(`${SCREEN_STREAM}:screen`)?.currentEpoch).toBe((screenEpoch ?? 0) + 1);
    expect(trackAnnounces(p.sent, SCREEN_STREAM, 'screen').map(recipientsOf)).toEqual([['300']]);
    expect(trackAnnounces(p.sent, CAMERA_STREAM, 'camera')).toEqual([]);
    expect(p.lost).not.toHaveBeenCalled();
    await p.engine.disconnect();
  });

  it('still rotates every key when a member leaves, and the departed member gets none of the new ones', async () => {
    const p = await withMemberAndViewer();
    const voiceEpoch = p.internals.senderKeys.currentEpoch;
    const cameraEpoch = p.internals.trackSenders?.get(`${CAMERA_STREAM}:camera`)?.currentEpoch ?? 0;
    p.sent.length = 0;
    p.internals.handleStreamControlMessage({ type: 'session_participant_leave', user_id: '300', session_id: 'r-300' });
    await settle();
    expect(p.leaves).toEqual(['300']);
    expect(p.internals.senderKeys.currentEpoch).toBe(voiceEpoch + 1);
    expect(p.internals.trackSenders?.get(`${CAMERA_STREAM}:camera`)?.currentEpoch).toBe(cameraEpoch + 1);
    for (const message of p.sent.filter((m) => m.type === 'key_announce' || m.type === 'stream_key_announce')) {
      expect(recipientsOf(message)).not.toContain('300');
    }
    // The viewer still watching gets the screen's new keys, never the voice's.
    expect(trackAnnounces(p.sent, SCREEN_STREAM, 'screen').map(recipientsOf)).toEqual([['400']]);
    expect(p.sent.filter((m) => m.type === 'key_announce')).toEqual([]);
    await p.engine.disconnect();
  });

  it('rotates every key when a member joins, and the joiner gets the voice key', async () => {
    const p = await withMemberAndViewer();
    const voiceEpoch = p.internals.senderKeys.currentEpoch;
    p.sent.length = 0;
    const nick = MediaKeyring.create();
    p.internals.handleStreamControlMessage({
      type: 'session_participant_join',
      participant: entry('600', 'r-600', nick, 'member'),
    });
    await settle();
    expect(p.joins).toEqual(['300', '600']);
    expect(p.internals.senderKeys.currentEpoch).toBe(voiceEpoch + 1);
    expect(p.sent.filter((m) => m.type === 'key_announce').map(recipientsOf)).toEqual([['300', '600']]);
    await p.engine.disconnect();
  });

  it('takes a member that turns into a viewer as a member that left the call', async () => {
    const p = await withMemberAndViewer();
    const voiceEpoch = p.internals.senderKeys.currentEpoch;
    p.sent.length = 0;
    // Brendan leaves the call and starts watching; the relay's view join can
    // overtake the old call's leave.
    p.internals.handleStreamControlMessage({
      type: 'session_participant_join',
      participant: entry('300', 'view-300', p.brendan, 'viewer'),
    });
    await settle();
    expect(p.leaves).toEqual(['300']);
    expect(p.internals.senderKeys.currentEpoch).toBe(voiceEpoch + 1);
    for (const message of p.sent.filter((m) => m.type === 'key_announce')) {
      expect(recipientsOf(message)).not.toContain('300');
    }
    // The old call's leave, arriving late, removes nothing.
    p.internals.handleStreamControlMessage({ type: 'session_participant_leave', user_id: '300', session_id: 'r-300' });
    await settle();
    expect(p.leaves).toEqual(['300']);
    await p.engine.disconnect();
  });

  it('takes an entry without a mark as a member, and refuses one of an unknown kind', async () => {
    const p = await publisher();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    p.internals.handleStreamControlMessage({
      type: 'session_state',
      participants: [
        entry('300', 'r-300', MediaKeyring.create()),
        { ...entry('700', 'r-700', MediaKeyring.create()), kind: 'lurker' },
      ],
    });
    await settle();
    expect(p.joins).toEqual(['300']);
    for (const message of p.sent.filter((m) => m.type === 'key_announce' || m.type === 'stream_key_announce')) {
      expect(recipientsOf(message)).not.toContain('700');
    }
    warn.mockRestore();
    await p.engine.disconnect();
  });
});

describe('per-track sender keys', () => {
  it('encrypts each track under its own key, and refuses a frame for a track that has none', async () => {
    const p = await publisher();
    const keys = new Set<string>();
    keys.add(Array.from(await p.internals.senderKeys.exportKey()).join(','));
    for (const trackId of ['screen', 'screen-audio', 'camera']) {
      const stream = trackId === 'camera' ? CAMERA_STREAM : SCREEN_STREAM;
      keys.add(Array.from(await p.internals.trackSenders!.get(`${stream}:${trackId}`)!.exportKey()).join(','));
    }
    expect(keys.size).toBe(4);
    p.internals.trackSenders!.clear();
    expect(() => (p.engine as unknown as { localTrackSender(id: string): unknown }).localTrackSender('screen'))
      .toThrow(/No sender key for the local screen track/);
    await p.engine.disconnect();
  });
});

describe('frame taps', () => {
  it('hands a tap its own copy of each decoded frame, beside a surface, without a canvas', () => {
    const engine = new BrowserMediaEngine();
    const internals = engine as unknown as {
      videoSubscriptions: Map<string, { sinks: unknown[] }>;
      renderToSinks(subscription: unknown, frame: VideoFrame): void;
    };
    vi.stubGlobal('VideoDecoder', class { configure() {} decode() {} close() {} reset() {} flush() { return Promise.resolve(); } static isConfigSupported = async () => ({ supported: true }); });
    const tapped: VideoFrame[] = [];
    const tap = engine.tapVideoFrames('200', 'screen', (frame) => tapped.push(frame));
    const subscription = internals.videoSubscriptions.get('200:screen')!;
    expect(subscription.sinks).toHaveLength(1);

    const clone = { close: vi.fn() } as unknown as VideoFrame;
    const original = { clone: () => clone, close: vi.fn() } as unknown as VideoFrame;
    internals.renderToSinks(subscription, original);
    expect(tapped).toEqual([original]);

    tap.release();
    expect(internals.videoSubscriptions.has('200:screen')).toBe(false);
    void engine.disconnect();
  });

  it('keeps a subscription as it is when the relay repeats an unchanged publish (no replayed key, no decoder reset)', async () => {
    vi.stubGlobal('VideoDecoder', class { configure() {} decode() {} close() {} reset() {} flush() { return Promise.resolve(); } static isConfigSupported = async () => ({ supported: true }); });
    const engine = new BrowserMediaEngine();
    const internals = engine as unknown as {
      transport: { sendStreamControl: (message: unknown) => Promise<void>; disconnect: () => Promise<void> } | null;
      videoSubscriptions: Map<string, { decoder: { reset(): void } }>;
      handleStreamControlMessage(message: Record<string, unknown>): void;
    };
    const sent: Array<Record<string, unknown>> = [];
    internals.transport = { sendStreamControl: async (m) => { sent.push(m as Record<string, unknown>); }, disconnect: async () => {} };
    const tap = engine.tapVideoFrames('200', 'screen', () => {});
    const track = {
      streamId: 'stream:200:screen', trackId: 'screen', publisherUserId: '200', kind: 'video', codec: 'vp9',
      layers: [{ layerId: 0, ssrc: 21, width: 320, height: 180, active: true }, { layerId: 1, ssrc: 22, width: 1280, height: 720, active: true }],
    };
    internals.handleStreamControlMessage({ type: 'track_publish', track });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const subscribes = () => sent.filter((m) => m.type === 'subscribe_stream').length;
    expect(subscribes()).toBe(1);
    const reset = vi.spyOn(internals.videoSubscriptions.get('200:screen')!.decoder, 'reset');

    // The same publish again (the relay repeats it after every key announce).
    internals.handleStreamControlMessage({ type: 'track_publish', track: structuredClone(track) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(subscribes()).toBe(1);
    expect(reset).not.toHaveBeenCalled();

    // A real change (a new codec) still resubscribes and starts a new decoder.
    internals.handleStreamControlMessage({ type: 'track_publish', track: { ...track, codec: 'av1' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(subscribes()).toBe(2);
    tap.release();
    await engine.disconnect();
  });

  it('reports the frames route on the browser', async () => {
    vi.stubGlobal('VideoDecoder', class { configure() {} decode() {} close() {} reset() {} flush() { return Promise.resolve(); } });
    const engine = new BrowserMediaEngine();
    const tap = engine.tapVideoFrames('200', 'screen', () => {});
    await expect(tap.route).resolves.toBe('frames');
    tap.release();
    await engine.disconnect();
  });
});
