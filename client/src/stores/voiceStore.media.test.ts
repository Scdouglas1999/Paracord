import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '../lib/operationContext';
import type { MediaEngine, PeerRole } from '../lib/media/mediaEngine';

// The Glass media contract of the voice store (docs/design/glass-g6-checkpoint.md):
// listen, the in-place upgrade, watch (with and without the call), ambient,
// watcher counts and the Glass voice-state fields.

const fixture = vi.hoisted(() => ({
  selected: 'A', user: '1',
  join: vi.fn(), leave: vi.fn(), setMode: vi.fn(), startView: vi.fn(), stopView: vi.fn(), watchers: vi.fn(),
  factory: vi.fn(), publish: vi.fn(),
}));
vi.mock('../lib/tauriEnv', () => ({ isTauri: () => false }));
vi.mock('../lib/features/voiceSounds', () => ({ playVoiceJoinSound: vi.fn(), playVoiceLeaveSound: vi.fn() }));
vi.mock('../gateway/manager', () => ({ gateway: { updateVoiceState: fixture.publish } }));
vi.mock('../lib/operationContext', () => ({
  captureOperationContext: (serverId?: string) => {
    const scope = { serverId: serverId ?? fixture.selected, userId: fixture.user };
    const controller = new AbortController();
    return { scope, key: accountScopeKey(scope), signal: controller.signal,
      user: { id: scope.userId, username: `user-${scope.userId}` },
      assertCurrent: () => { if (controller.signal.aborted) throw new DOMException('Account expired', 'AbortError'); },
      dispose: () => controller.abort(),
    } as unknown as OperationContext;
  },
}));
vi.mock('../api/voice', () => ({
  createCallVoiceApi: (context: OperationContext) => ({
    join: (channel: string, dm: boolean, fallback: string | undefined, mode: string) => fixture.join(context.scope.serverId, channel, dm, fallback, mode),
    leave: (channel: string, dm: boolean, session: string) => fixture.leave(context.scope.serverId, channel, dm, session),
    setMode: (channel: string, mode: string, session: string) => fixture.setMode(channel, mode, session),
    startView: (channel: string, kind: string, streamer: string) => fixture.startView(channel, kind, streamer),
    stopView: (channel: string, session: string) => fixture.stopView(channel, session),
    watchers: (channel: string) => fixture.watchers(channel),
    mediaCertificatePin: vi.fn(async () => 'pin'),
    startStream: vi.fn(async () => ({ data: {} })), stopStream: vi.fn(async () => {}),
  }),
}));
vi.mock('../lib/media/mediaEngine', () => ({ createMediaEngine: () => fixture.factory() }));

import { selectWatcherCount, useVoiceStore } from './voiceStore';
import { accountScopeKey } from '../lib/serverScope';
import { useServerListStore } from './serverListStore';
import { useGuildStore } from './guildStore';
import { isListeningIn, liveMinutes } from './voice/selectors';
import { VIEW_CONNECT_DEADLINE_MS } from './voice/viewSessions';

const SCOPE = { serverId: 'A', userId: '1' };

function fakeEngine() {
  const callbacks: {
    lost?: (reason: string) => void;
    join?: (id: string) => void;
    leave?: (id: string) => void;
    resolver?: (id: string) => PeerRole;
  } = {};
  const releaseAudio = vi.fn();
  const mock = {
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), setMute: vi.fn(), setDeaf: vi.fn(),
    onParticipantJoin: (cb: (id: string) => void) => { callbacks.join = cb; },
    onParticipantLeave: (cb: (id: string) => void) => { callbacks.leave = cb; },
    onSpeakingChange: vi.fn(),
    onTransportLost: (cb: (reason: string) => void) => { callbacks.lost = cb; },
    setPeerRoleResolver: (resolver: (id: string) => PeerRole) => { callbacks.resolver = resolver; },
    startMicrophone: vi.fn(async () => {}),
    subscribeScreenShareAudio: vi.fn(() => releaseAudio),
    setSourceVolume: vi.fn(),
    tapVideoFrames: vi.fn(() => ({ route: Promise.resolve('frames'), release: vi.fn() })),
  };
  return { engine: mock as unknown as MediaEngine, mock, callbacks, releaseAudio };
}
type Fake = ReturnType<typeof fakeEngine>;

function joinResponse(session = 'call-receipt', mode = 'joined') {
  return { data: { token: 'token', url: 'https://media.example', room_name: 'room', session_id: session, mode,
    native_media: true, media_endpoint: 'https://media.example', media_token: 'call-media-token', cert_hash: 'pin' } };
}
function viewResponse(kind: string, session = 'view-receipt') {
  return { data: { channel_id: 'lounge', guild_id: 'guild', kind, user_id: 'vincent', via_membership: false,
    session_id: session, media: { media_endpoint: 'https://media.example', media_endpoint_candidates: [],
      media_token: `${kind}-media-token`, cert_hash: 'pin', room_name: 'guild:lounge' } } };
}
function viaMembership(kind: string) {
  return { data: { channel_id: 'lounge', guild_id: 'guild', kind, user_id: 'vincent', via_membership: true,
    session_id: null, media: null } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const WATCH = { guildId: 'guild', channelId: 'lounge', streamerId: 'vincent' };

let engines: Fake[] = [];
function queueEngines(count: number): Fake[] {
  const created = Array.from({ length: count }, () => fakeEngine());
  for (const fake of created) fixture.factory.mockResolvedValueOnce(fake.engine);
  engines.push(...created);
  return created;
}

let visibility: DocumentVisibilityState = 'visible';
beforeEach(async () => {
  await useVoiceStore.getState().reset(); await flush();
  fixture.selected = 'A'; fixture.user = '1'; engines = [];
  fixture.join.mockReset().mockResolvedValue(joinResponse());
  fixture.leave.mockReset().mockResolvedValue(undefined);
  fixture.setMode.mockReset().mockResolvedValue({ data: { channel_id: 'lounge', session_id: 'call-receipt', mode: 'joined', can_publish: true } });
  fixture.startView.mockReset().mockImplementation(async (_channel: string, kind: string) => viewResponse(kind));
  fixture.stopView.mockReset().mockResolvedValue(undefined);
  fixture.watchers.mockReset();
  fixture.factory.mockReset().mockImplementation(async () => { const fake = fakeEngine(); engines.push(fake); return fake.engine; });
  fixture.publish.mockReset();
  useVoiceStore.setState({ useNativeMedia: true, selfMute: false, selfDeaf: false });
  useServerListStore.setState({ activeServerId: 'A' });
  useGuildStore.setState({ selectedGuild: { id: 'guild', scope: SCOPE } });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(async () => {
  vi.useRealTimers();
  await useVoiceStore.getState().reset(); await flush();
});

function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

// ── Listen ──────────────────────────────────────────────────────────────────

describe('listen in', () => {
  it('joins receive-only: mode listen on the wire, a listening engine, muted, and "Listening in"', async () => {
    const [call] = queueEngines(1);
    await useVoiceStore.getState().listen('lounge', 'guild');
    expect(fixture.join).toHaveBeenCalledWith('A', 'lounge', false, undefined, 'listen');
    expect(call.mock.connect).toHaveBeenCalledWith('https://media.example', 'call-media-token', 'pin',
      expect.objectContaining({ role: 'listen' }));
    expect(call.mock.setMute).toHaveBeenCalledWith(true);
    const state = useVoiceStore.getState();
    expect(state.callMode).toBe('listen');
    expect(state.connected).toBe(true);
    expect(isListeningIn(state.participants.get('1'))).toBe(true);
  });

  it('never listens in to a direct message call', async () => {
    await expect(useVoiceStore.getState().listen('dm-channel', 'dm')).rejects.toThrow(/server voice channels/);
    expect(fixture.join).not.toHaveBeenCalled();
  });

  it('shows LISTEN_IN_DISABLED as it is and never turns the listen into a join', async () => {
    fixture.join.mockRejectedValueOnce({ response: { status: 403, data: {
      code: 'LISTEN_IN_DISABLED', message: 'Listening in is turned off for this voice channel' } } });
    await useVoiceStore.getState().listen('lounge', 'guild');
    const state = useVoiceStore.getState();
    expect(state.connectionErrorCode).toBe('LISTEN_IN_DISABLED');
    expect(state.connectionError).toBe('Listening in is turned off for this voice channel');
    expect(state.connectionErrorChannelId).toBe('lounge');
    expect(state.connected).toBe(false);
    expect(state.callMode).toBeNull();
    expect(fixture.join).toHaveBeenCalledTimes(1);
    expect(fixture.factory).not.toHaveBeenCalled();
  });

  it('upgrades to joined in place: POST /mode on the same receipt, the microphone opens, no reconnect', async () => {
    const [call] = queueEngines(1);
    await useVoiceStore.getState().listen('lounge', 'guild');
    await useVoiceStore.getState().joinFromListen();
    expect(fixture.setMode).toHaveBeenCalledWith('lounge', 'joined', 'call-receipt');
    expect(call.mock.startMicrophone).toHaveBeenCalledTimes(1);
    expect(fixture.factory).toHaveBeenCalledTimes(1);
    expect(call.mock.connect).toHaveBeenCalledTimes(1);
    expect(call.mock.disconnect).not.toHaveBeenCalled();
    expect(fixture.join).toHaveBeenCalledTimes(1);
    const state = useVoiceStore.getState();
    expect(state.callMode).toBe('joined');
    expect(state.mediaEngine).toBe(call.engine);
    expect(state.participants.get('1')?.mode).toBe('joined');
    // Unmuted: the mute preference was off.
    expect(call.mock.setMute).toHaveBeenLastCalledWith(false);
  });

  it('keeps the mute preference across the upgrade', async () => {
    const [call] = queueEngines(1);
    await useVoiceStore.getState().listen('lounge', 'guild');
    await useVoiceStore.getState().toggleMute();
    expect(useVoiceStore.getState().selfMute).toBe(true);
    await useVoiceStore.getState().joinFromListen();
    expect(call.mock.setMute).toHaveBeenLastCalledWith(true);
    expect(useVoiceStore.getState().selfMute).toBe(true);
  });

  it('joinChannel on the channel being listened to is the same in-place upgrade', async () => {
    queueEngines(1);
    await useVoiceStore.getState().listen('lounge', 'guild');
    await useVoiceStore.getState().joinChannel('lounge', 'guild');
    expect(fixture.setMode).toHaveBeenCalledTimes(1);
    expect(fixture.join).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().callMode).toBe('joined');
  });

  it('puts the server back to listening when the microphone cannot open', async () => {
    const [call] = queueEngines(1);
    call.mock.startMicrophone.mockRejectedValueOnce(new Error('Permission denied'));
    await useVoiceStore.getState().listen('lounge', 'guild');
    await expect(useVoiceStore.getState().joinFromListen()).rejects.toThrow('Permission denied');
    expect(fixture.setMode.mock.calls).toEqual([
      ['lounge', 'joined', 'call-receipt'],
      ['lounge', 'listen', 'call-receipt'],
    ]);
    const state = useVoiceStore.getState();
    expect(state.callMode).toBe('listen');
    expect(state.connected).toBe(true);
    expect(state.modeError).toMatch(/still listening in/);
  });

  it('leaves while listening: the engine goes, the membership is released with its receipt', async () => {
    const [call] = queueEngines(1);
    await useVoiceStore.getState().listen('lounge', 'guild');
    await useVoiceStore.getState().leaveChannel();
    await flush();
    expect(call.mock.disconnect).toHaveBeenCalledTimes(1);
    expect(fixture.leave).toHaveBeenCalledWith('A', 'lounge', false, 'call-receipt');
    expect(useVoiceStore.getState().callMode).toBeNull();
    expect(useVoiceStore.getState().connected).toBe(false);
  });

  it('never shares a screen, turns on a camera or switches the microphone while listening', async () => {
    const [call] = queueEngines(1);
    await useVoiceStore.getState().listen('lounge', 'guild');
    await expect(useVoiceStore.getState().startStream()).rejects.toThrow(/Join the call/);
    await expect(useVoiceStore.getState().applyAudioInputDevice('usb-mic')).resolves.toBe(true);
    expect(call.mock.startMicrophone).not.toHaveBeenCalled();
  });
});

// ── Watch ───────────────────────────────────────────────────────────────────

describe('watch', () => {
  it('watches without joining: a separate view session, the stream’s own audio, no call', async () => {
    const [view] = queueEngines(1);
    await useVoiceStore.getState().startWatch(WATCH);
    expect(fixture.startView).toHaveBeenCalledWith('lounge', 'watch', 'vincent');
    expect(fixture.join).not.toHaveBeenCalled();
    expect(view.mock.connect).toHaveBeenCalledWith('https://media.example', 'watch-media-token', 'pin',
      expect.objectContaining({ role: 'view' }));
    expect(view.mock.subscribeScreenShareAudio).toHaveBeenCalledWith('vincent', expect.any(Function));
    const watch = useVoiceStore.getState().watchView!;
    expect(watch).toMatchObject({ phase: 'live', route: 'session', sessionId: 'view-receipt', streamerId: 'vincent' });
    expect(watch.engine).toBe(view.engine);
    expect(useVoiceStore.getState().connected).toBe(false);

    await useVoiceStore.getState().stopWatch();
    await flush();
    expect(fixture.stopView).toHaveBeenCalledWith('lounge', 'view-receipt');
    expect(view.mock.disconnect).toHaveBeenCalled();
    expect(view.releaseAudio).toHaveBeenCalled();
    expect(useVoiceStore.getState().watchView).toBeNull();
  });

  it('coexists with a call in another channel', async () => {
    const [call, view] = queueEngines(2);
    await useVoiceStore.getState().joinChannel('general-voice', 'guild');
    await useVoiceStore.getState().startWatch(WATCH);
    expect(useVoiceStore.getState().watchView?.engine).toBe(view.engine);
    expect(useVoiceStore.getState().mediaEngine).toBe(call.engine);
    await useVoiceStore.getState().stopWatch();
    expect(call.mock.disconnect).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().connected).toBe(true);
  });

  it('rides the call when in it: no second connection, counted by the server, stopping never leaves', async () => {
    const [call] = queueEngines(1);
    await useVoiceStore.getState().joinChannel('lounge', 'guild');
    fixture.startView.mockResolvedValueOnce(viaMembership('watch'));
    await useVoiceStore.getState().startWatch(WATCH);
    expect(fixture.factory).toHaveBeenCalledTimes(1);
    const watch = useVoiceStore.getState().watchView!;
    expect(watch).toMatchObject({ phase: 'live', route: 'call' });
    expect(watch.engine).toBe(call.engine);
    expect(call.mock.subscribeScreenShareAudio).toHaveBeenCalledWith('vincent', expect.any(Function));

    await useVoiceStore.getState().stopWatch();
    await flush();
    // Scoped to the call's receipt, so the server stops the watch and nothing else.
    expect(fixture.stopView).toHaveBeenCalledWith('lounge', 'call-receipt');
    expect(call.mock.disconnect).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().connected).toBe(true);
  });

  it('stays ended when the relay supersedes it: no retry', async () => {
    const [view] = queueEngines(1);
    await useVoiceStore.getState().startWatch(WATCH);
    view.callbacks.lost?.('superseded by a newer media connection');
    await flush();
    expect(useVoiceStore.getState().watchView).toMatchObject({ phase: 'ended', endReason: 'superseded', engine: null });
    expect(view.mock.disconnect).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fixture.startView).toHaveBeenCalledTimes(1);
    expect(fixture.factory).toHaveBeenCalledTimes(1);
  });

  it('stays ended when the view session ends, and fails without retry on any other drop', async () => {
    const [first] = queueEngines(1);
    await useVoiceStore.getState().startWatch(WATCH);
    first.callbacks.lost?.('view session ended');
    await flush();
    expect(useVoiceStore.getState().watchView).toMatchObject({ phase: 'ended', endReason: 'ended' });

    await useVoiceStore.getState().stopWatch();
    const [second] = queueEngines(1);
    await useVoiceStore.getState().startWatch(WATCH);
    second.callbacks.lost?.('Connection lost');
    await flush();
    expect(useVoiceStore.getState().watchView).toMatchObject({ phase: 'failed', endReason: 'failed', error: 'Connection lost' });
    expect(fixture.startView).toHaveBeenCalledTimes(2);
  });

  it('fails at the connect deadline and asks for nothing again', async () => {
    vi.useFakeTimers();
    const [view] = queueEngines(1);
    view.mock.connect.mockImplementation(() => new Promise(() => {}));
    const watching = useVoiceStore.getState().startWatch(WATCH).catch((error) => error);
    await vi.advanceTimersByTimeAsync(VIEW_CONNECT_DEADLINE_MS - 100);
    expect(useVoiceStore.getState().watchView?.phase).toBe('connecting');
    await vi.advanceTimersByTimeAsync(200);
    const error = await watching;
    expect((error as Error).message).toMatch(/did not connect within 20 seconds/);
    expect(useVoiceStore.getState().watchView).toMatchObject({ phase: 'failed', endReason: 'deadline' });
    expect(view.mock.disconnect).toHaveBeenCalled();
    expect(fixture.stopView).toHaveBeenCalledWith('lounge', 'view-receipt');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.startView).toHaveBeenCalledTimes(1);
  });

  it('reports a refused watch in the server’s words, without retrying', async () => {
    fixture.startView.mockRejectedValueOnce({ response: { status: 409, data: { code: 'CONFLICT', message: 'That person is not streaming in this channel' } } });
    await expect(useVoiceStore.getState().startWatch(WATCH)).rejects.toBeDefined();
    expect(useVoiceStore.getState().watchView).toMatchObject({ phase: 'failed', error: 'That person is not streaming in this channel' });
    expect(fixture.factory).not.toHaveBeenCalled();
  });

  it('moves onto the call when this client joins the channel it watches', async () => {
    const [view, call] = queueEngines(2);
    await useVoiceStore.getState().startWatch(WATCH);
    fixture.startView.mockResolvedValueOnce(viaMembership('watch'));
    await useVoiceStore.getState().joinChannel('lounge', 'guild');
    await flush();
    // The relay then closes the view session; expected, and ignored.
    view.callbacks.lost?.('view session ended');
    await flush();
    const watch = useVoiceStore.getState().watchView!;
    expect(watch).toMatchObject({ phase: 'live', route: 'call' });
    expect(watch.engine).toBe(call.engine);
    expect(view.mock.disconnect).toHaveBeenCalled();
    // The carried-over watch is not stopped on the server.
    expect(fixture.stopView).not.toHaveBeenCalled();
  });

  it('moves back onto a session of its own when this client leaves the call (Leave never stops a watch)', async () => {
    const [call, view] = queueEngines(2);
    await useVoiceStore.getState().joinChannel('lounge', 'guild');
    fixture.startView.mockResolvedValueOnce(viaMembership('watch'));
    await useVoiceStore.getState().startWatch(WATCH);
    const leaving = deferred<void>();
    fixture.leave.mockReturnValueOnce(leaving.promise);
    await useVoiceStore.getState().leaveChannel();
    await flush();
    expect(useVoiceStore.getState().watchView).toMatchObject({ phase: 'connecting', engine: null });
    // Not before the server has released the membership.
    expect(fixture.startView).toHaveBeenCalledTimes(1);
    leaving.resolve();
    await flush(); await flush();
    expect(fixture.startView).toHaveBeenCalledTimes(2);
    const watch = useVoiceStore.getState().watchView!;
    expect(watch).toMatchObject({ phase: 'live', route: 'session' });
    expect(watch.engine).toBe(view.engine);
    expect(call.mock.disconnect).toHaveBeenCalled();
  });

  it('replaces one watch with another', async () => {
    const [first, second] = queueEngines(2);
    await useVoiceStore.getState().startWatch(WATCH);
    fixture.startView.mockResolvedValueOnce({ data: { ...viewResponse('watch', 'view-2').data, user_id: 'brendan' } });
    await useVoiceStore.getState().startWatch({ ...WATCH, streamerId: 'brendan' });
    expect(first.mock.disconnect).toHaveBeenCalled();
    expect(fixture.stopView).toHaveBeenCalledWith('lounge', 'view-receipt');
    expect(useVoiceStore.getState().watchView?.engine).toBe(second.engine);
    // The same target again is the running watch.
    await useVoiceStore.getState().startWatch({ ...WATCH, streamerId: 'brendan' });
    expect(fixture.startView).toHaveBeenCalledTimes(2);
  });
});

// ── Ambient ─────────────────────────────────────────────────────────────────

describe('ambient', () => {
  it('opens one lightweight view for the room, once per target', async () => {
    const [view] = queueEngines(1);
    useVoiceStore.getState().startAmbient(WATCH);
    await flush();
    expect(fixture.startView).toHaveBeenCalledWith('lounge', 'ambient', 'vincent');
    expect(view.mock.connect).toHaveBeenCalledWith('https://media.example', 'ambient-media-token', 'pin',
      expect.objectContaining({ role: 'view' }));
    expect(view.mock.subscribeScreenShareAudio).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().ambientView).toMatchObject({ phase: 'live', route: 'session' });
    useVoiceStore.getState().startAmbient(WATCH);
    await flush();
    expect(fixture.startView).toHaveBeenCalledTimes(1);

    useVoiceStore.getState().stopAmbient();
    await flush();
    expect(fixture.stopView).toHaveBeenCalledWith('lounge', 'view-receipt');
    expect(view.mock.disconnect).toHaveBeenCalled();
    expect(useVoiceStore.getState().ambientView).toBeNull();
  });

  it('closes while the window is hidden and opens a fresh view when it is shown', async () => {
    const [first, second] = queueEngines(2);
    useVoiceStore.getState().startAmbient(WATCH);
    await flush();
    setVisibility('hidden');
    await flush();
    expect(first.mock.disconnect).toHaveBeenCalled();
    expect(fixture.stopView).toHaveBeenCalledWith('lounge', 'view-receipt');
    expect(useVoiceStore.getState().ambientView).toMatchObject({ phase: 'paused', pauseReason: 'hidden', engine: null });
    setVisibility('visible');
    await flush();
    expect(fixture.startView).toHaveBeenCalledTimes(2);
    expect(useVoiceStore.getState().ambientView?.engine).toBe(second.engine);
  });

  it('stays closed while its server is not the current one', async () => {
    useGuildStore.setState({ selectedGuild: { id: 'basecamp', scope: SCOPE } });
    useVoiceStore.getState().startAmbient(WATCH);
    await flush();
    expect(fixture.startView).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().ambientView).toMatchObject({ phase: 'paused', pauseReason: 'server-not-current' });
    const [view] = queueEngines(1);
    useGuildStore.setState({ selectedGuild: { id: 'guild', scope: SCOPE } });
    await flush();
    expect(useVoiceStore.getState().ambientView?.engine).toBe(view.engine);
  });

  it('rides the call in its channel without asking the server', async () => {
    const [call] = queueEngines(1);
    await useVoiceStore.getState().joinChannel('lounge', 'guild');
    useVoiceStore.getState().startAmbient(WATCH);
    await flush();
    expect(fixture.startView).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().ambientView).toMatchObject({ phase: 'live', route: 'call' });
    expect(useVoiceStore.getState().ambientView?.engine).toBe(call.engine);
  });

  it('rides a watch of the same stream, and is blocked by a watch of another', async () => {
    const [watchEngine] = queueEngines(1);
    await useVoiceStore.getState().startWatch(WATCH);
    useVoiceStore.getState().startAmbient(WATCH);
    await flush();
    expect(useVoiceStore.getState().ambientView).toMatchObject({ phase: 'live', route: 'watch' });
    expect(useVoiceStore.getState().ambientView?.engine).toBe(watchEngine.engine);
    expect(fixture.startView).toHaveBeenCalledTimes(1);

    useVoiceStore.getState().startAmbient({ ...WATCH, streamerId: 'brendan' });
    await flush();
    expect(useVoiceStore.getState().ambientView).toMatchObject({ phase: 'blocked' });
    expect(fixture.startView).toHaveBeenCalledTimes(1);

    const [ambientEngine] = queueEngines(1);
    await useVoiceStore.getState().stopWatch();
    await flush();
    expect(fixture.startView).toHaveBeenLastCalledWith('lounge', 'ambient', 'brendan');
    expect(useVoiceStore.getState().ambientView?.engine).toBe(ambientEngine.engine);
  });

  it('stays down after being superseded until the room asks again', async () => {
    const [view] = queueEngines(1);
    useVoiceStore.getState().startAmbient(WATCH);
    await flush();
    view.callbacks.lost?.('superseded by a newer media connection');
    await flush();
    setVisibility('hidden'); setVisibility('visible');
    await flush();
    expect(useVoiceStore.getState().ambientView).toMatchObject({ phase: 'ended', endReason: 'superseded' });
    expect(fixture.startView).toHaveBeenCalledTimes(1);
  });
});

// ── Watcher counts and the Glass voice-state fields ────────────────────────

describe('watcher counts', () => {
  const snapshot = (streams: Array<{ user_id: string; watchers: number }>) =>
    ({ guild_id: 'guild', channel_id: 'lounge', streams });

  it('keeps a complete per-channel snapshot, scoped to the account', () => {
    const store = useVoiceStore.getState();
    store.handleWatchersUpdate(snapshot([{ user_id: 'vincent', watchers: 2 }]), SCOPE);
    expect(selectWatcherCount(useVoiceStore.getState(), SCOPE, 'lounge', 'vincent')).toBe(2);
    expect(selectWatcherCount(useVoiceStore.getState(), { serverId: 'B', userId: '1' }, 'lounge', 'vincent')).toBe(0);
    const before = useVoiceStore.getState().watchers;
    store.handleWatchersUpdate(snapshot([{ user_id: 'vincent', watchers: 2 }]), SCOPE);
    expect(useVoiceStore.getState().watchers).toBe(before);
    store.handleWatchersUpdate(snapshot([]), SCOPE);
    expect(selectWatcherCount(useVoiceStore.getState(), SCOPE, 'lounge', 'vincent')).toBe(0);
    expect(useVoiceStore.getState().watchers.size).toBe(0);
  });

  it('loads a channel’s counts on demand', async () => {
    fixture.watchers.mockResolvedValueOnce({ data: snapshot([{ user_id: 'vincent', watchers: 1 }]) });
    await useVoiceStore.getState().fetchWatchers({ channelId: 'lounge' });
    expect(selectWatcherCount(useVoiceStore.getState(), SCOPE, 'lounge', 'vincent')).toBe(1);
  });
});

describe('the Glass voice-state fields', () => {
  it('carries mode and the stream start time from the gateway', () => {
    useVoiceStore.getState().loadVoiceStates('guild', [{
      user_id: '7', channel_id: 'lounge', guild_id: 'guild', session_id: 'r7', mode: 'joined',
      self_stream: true, self_stream_started_at: '2026-09-30T20:30:00Z',
      self_mute: false, self_deaf: false, self_video: false, mute: false, deaf: false, suppress: false,
    }], SCOPE);
    useVoiceStore.getState().handleVoiceStateUpdate({
      user_id: '8', channel_id: 'lounge', guild_id: 'guild', session_id: 'r8', mode: 'listen',
      self_stream: false, self_stream_started_at: null,
      self_mute: true, self_deaf: false, self_video: false, mute: false, deaf: false, suppress: false,
    }, SCOPE);
    const state = useVoiceStore.getState();
    const vincent = state.participants.get('7');
    expect(liveMinutes(vincent, Date.parse('2026-09-30T21:12:30Z'))).toBe(42);
    expect(isListeningIn(state.participants.get('8'))).toBe(true);
    expect(state.channelParticipants.get('lounge')?.map((member) => member.mode)).toEqual(['joined', 'listen']);
  });
});

describe('telling viewers from members in the relay roster', () => {
  it('is a member with a voice state in the channel, a viewer without, and a member once seen', async () => {
    const [call] = queueEngines(1);
    useVoiceStore.getState().loadVoiceStates('guild', [{
      user_id: '7', channel_id: 'lounge', guild_id: 'guild', session_id: 'r7',
      self_stream: true, self_mute: false, self_deaf: false, self_video: false, mute: false, deaf: false, suppress: false,
    }], SCOPE);
    await useVoiceStore.getState().joinChannel('lounge', 'guild');
    const resolve = call.callbacks.resolver!;
    expect(resolve('7')).toBe('member');
    expect(resolve('400')).toBe('viewer');
    useVoiceStore.getState().handleVoiceStateUpdate({
      user_id: '500', channel_id: 'lounge', guild_id: 'guild', session_id: 'r5',
      self_stream: false, self_mute: false, self_deaf: false, self_video: false, mute: false, deaf: false, suppress: false,
    }, SCOPE);
    useVoiceStore.getState().handleVoiceStateUpdate({
      user_id: '500', channel_id: undefined, session_id: 'r5',
      self_stream: false, self_mute: false, self_deaf: false, self_video: false, mute: false, deaf: false, suppress: false,
    }, SCOPE);
    // Its voice state is gone before its media leave arrives: still a member.
    expect(resolve('500')).toBe('member');
  });
});
