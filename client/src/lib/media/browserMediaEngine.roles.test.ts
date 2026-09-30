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
  handleStreamControlMessage(message: Record<string, unknown>): void;
  materializeRemoteParticipant(userId: string): Promise<void>;
  publishedTracks: Map<string, unknown>;
}

async function publisher() {
  const engine = new BrowserMediaEngine();
  const internals = engine as unknown as Internals;
  internals.localUserId = '100';
  internals.localRoomId = '9';
  internals.membershipSessionId = 'receipt-self';
  internals.account = { assertCurrent: () => {} };
  const sent: Array<Record<string, unknown>> = [];
  internals.transport = { sendStreamControl: async (m) => { sent.push(m as Record<string, unknown>); }, disconnect: async () => {} };
  vi.spyOn(internals, 'materializeRemoteParticipant').mockResolvedValue(undefined);
  await internals.senderKeys.generateKey();
  // Our own screen share, so stream keys have something to announce.
  internals.publishedTracks.set('stream:100:screen:screen', {
    streamId: 'stream:100:screen', trackId: 'screen', publisherUserId: '100', kind: 'video', codec: 'vp9',
    layers: [{ layerId: 0, ssrc: 11, active: true }],
  });
  const joins: string[] = [];
  const leaves: string[] = [];
  engine.onParticipantJoin((id) => joins.push(id));
  engine.onParticipantLeave((id) => leaves.push(id));
  const rotate = vi.spyOn(internals.senderKeys, 'rotateKey');
  const joinRotate = vi.spyOn(internals.senderKeys, 'handleParticipantJoin');
  const leaveRotate = vi.spyOn(internals.senderKeys, 'handleParticipantLeave');
  return { engine, internals, sent, joins, leaves, rotate, joinRotate, leaveRotate };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('a publisher with viewers in its roster', () => {
  it('does not report a viewer as a call member and does not rotate the voice key for it', async () => {
    const p = await publisher();
    const members = new Set(['300']);
    p.engine.setPeerRoleResolver((id) => (members.has(id) ? 'member' : 'viewer'));
    const brendan = MediaKeyring.create();
    p.internals.handleStreamControlMessage({
      type: 'session_state',
      participants: [{ userId: '300', sessionId: 'r-300', videoCapabilities: [], mediaPublicKey: brendan.publicKey }],
    });
    await settle();
    expect(p.joins).toEqual(['300']);
    p.sent.length = 0;

    const sean = MediaKeyring.create();
    p.internals.handleStreamControlMessage({
      type: 'session_participant_join',
      participant: { userId: '400', sessionId: 'view-400', videoCapabilities: [], mediaPublicKey: sean.publicKey },
    });
    await settle();
    expect(p.joins).toEqual(['300']);
    expect(p.joinRotate).not.toHaveBeenCalled();
    expect(p.rotate).not.toHaveBeenCalled();
    // The viewer is owed the stream key, wrapped to it alone.
    const streamAnnounce = p.sent.find((m) => m.type === 'stream_key_announce');
    expect(streamAnnounce).toBeDefined();
    expect((streamAnnounce!.encrypted_keys as Array<[string, number[]]>).map(([id]) => id)).toEqual(['400']);

    p.internals.handleStreamControlMessage({ type: 'session_participant_leave', user_id: '400', session_id: 'view-400' });
    await settle();
    expect(p.leaves).toEqual([]);
    expect(p.leaveRotate).not.toHaveBeenCalled();
    await p.engine.disconnect();
  });

  it('treats a peer the gateway reported late as a member when it leaves ("member" wins)', async () => {
    const p = await publisher();
    const members = new Set<string>();
    p.engine.setPeerRoleResolver((id) => (members.has(id) ? 'member' : 'viewer'));
    p.internals.handleStreamControlMessage({ type: 'session_state', participants: [] });
    const late = MediaKeyring.create();
    p.internals.handleStreamControlMessage({
      type: 'session_participant_join',
      participant: { userId: '500', sessionId: 'r-500', videoCapabilities: [], mediaPublicKey: late.publicKey },
    });
    await settle();
    // Its voice state arrived after its media join.
    members.add('500');
    p.internals.handleStreamControlMessage({ type: 'session_participant_leave', user_id: '500', session_id: 'r-500' });
    await settle();
    expect(p.leaves).toEqual(['500']);
    expect(p.leaveRotate).toHaveBeenCalledWith('500');
    await p.engine.disconnect();
  });

  it('rotates on a member joining, as before', async () => {
    const p = await publisher();
    p.engine.setPeerRoleResolver(() => 'member');
    p.internals.handleStreamControlMessage({ type: 'session_state', participants: [] });
    const nick = MediaKeyring.create();
    p.internals.handleStreamControlMessage({
      type: 'session_participant_join',
      participant: { userId: '600', sessionId: 'r-600', videoCapabilities: [], mediaPublicKey: nick.publicKey },
    });
    await settle();
    expect(p.joins).toEqual(['600']);
    expect(p.joinRotate).toHaveBeenCalledWith('600');
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

  it('reports the frames route on the browser', async () => {
    vi.stubGlobal('VideoDecoder', class { configure() {} decode() {} close() {} reset() {} flush() { return Promise.resolve(); } });
    const engine = new BrowserMediaEngine();
    const tap = engine.tapVideoFrames('200', 'screen', () => {});
    await expect(tap.route).resolves.toBe('frames');
    tap.release();
    await engine.disconnect();
  });
});
