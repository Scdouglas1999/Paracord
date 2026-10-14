import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '../lib/operationContext';
import type { MediaEngine } from '../lib/media/mediaEngine';

const fixture = vi.hoisted(() => ({
  selected: 'A', user: '1', contexts: [] as Array<AbortController>,
  join: vi.fn(), leave: vi.fn(), factory: vi.fn(), publish: vi.fn(),
}));
vi.mock('../lib/tauriEnv', () => ({ isTauri: () => false }));
vi.mock('../lib/features/voiceSounds', () => ({ playVoiceJoinSound: vi.fn(), playVoiceLeaveSound: vi.fn() }));
vi.mock('../gateway/manager', () => ({ gateway: { updateVoiceState: fixture.publish } }));
vi.mock('../lib/operationContext', () => ({
  captureOperationContext: () => {
    const serverId = fixture.selected;
    const userId = fixture.user;
    const controller = new AbortController();
    fixture.contexts.push(controller);
    return { scope: { serverId, userId }, key: accountScopeKey({ serverId, userId }),
      signal: controller.signal, user: { id: userId, username: `user-${userId}` },
      assertCurrent: () => { if (controller.signal.aborted) throw new DOMException('Account expired', 'AbortError'); },
      dispose: () => controller.abort(),
    } as unknown as OperationContext;
  },
}));
vi.mock('../api/voice', () => ({
  createCallVoiceApi: (context: OperationContext) => ({
    join: (channel: string, dm: boolean, fallback?: string) => fixture.join(context.scope.serverId, channel, dm, fallback),
    leave: (channel: string, dm: boolean, session: string) => fixture.leave(context.scope.serverId, channel, dm, session),
    startStream: vi.fn(async () => ({ data: {} })), stopStream: vi.fn(async () => {}),
  }),
}));
vi.mock('../lib/media/mediaEngine', () => ({ createMediaEngine: () => fixture.factory() }));

import { useVoiceStore } from './voiceStore';
import { accountScopeKey } from '../lib/serverScope';
import { notifyServerDisconnected } from '../lib/serverDisconnect';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
function engine() {
  const callbacks: { lost?: (reason: string) => void; join?: (id: string) => void } = {};
  const transport = { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), setMute: vi.fn(), setDeaf: vi.fn(),
    onParticipantJoin: (cb: (id: string) => void) => { callbacks.join = cb; }, onParticipantLeave: vi.fn(),
    onSpeakingChange: vi.fn(), onTransportLost: (cb: (reason: string) => void) => { callbacks.lost = cb; },
  };
  return { transport: transport as unknown as MediaEngine, connect: transport.connect, disconnect: transport.disconnect, callbacks };
}
function response(session = 'receipt') {
  return { data: { token: 'token', url: 'https://media.example', room_name: 'room', session_id: session,
    native_media: true, media_endpoint: 'https://media.example', media_token: 'media-token' } };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

beforeEach(async () => {
  await useVoiceStore.getState().reset(); await flush();
  fixture.selected = 'A'; fixture.user = '1'; fixture.contexts = [];
  fixture.join.mockReset().mockResolvedValue(response()); fixture.leave.mockReset().mockResolvedValue(undefined);
  fixture.factory.mockReset().mockImplementation(async () => engine().transport);
  fixture.publish.mockReset();
  useVoiceStore.setState({ useNativeMedia: true });
});
afterEach(async () => { await useVoiceStore.getState().reset(); await flush(); });

describe('voiceStore call ownership across deferred boundaries', () => {
  it('keeps native preference when replacing an actual committed native call', async () => {
    const first = engine(); const second = engine();
    fixture.factory.mockResolvedValueOnce(first.transport).mockResolvedValueOnce(second.transport);
    await useVoiceStore.getState().joinChannel('one', 'guild');
    fixture.join.mockResolvedValue({ data: { ...response().data, native_media: undefined } });
    await useVoiceStore.getState().joinChannel('two', 'guild');
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledWith('https://media.example', 'media-token', undefined,
      expect.objectContaining({ account: expect.objectContaining({ scope: { serverId: 'A', userId: '1' } }) }));
    expect(useVoiceStore.getState().useNativeMedia).toBe(true);
    expect(useVoiceStore.getState().mediaEngine).toBe(second.transport);
  });

  it('keeps an Unmute pressed while the call is joining', async () => {
    // Stream-fix V7: the mic button is live as soon as the join starts. The
    // commit used to apply the mute the join began with and undo the toggle.
    const pending = deferred<void>(); const media = engine();
    media.connect.mockImplementation(() => pending.promise);
    fixture.factory.mockResolvedValue(media.transport);
    useVoiceStore.setState({ selfMute: true, selfDeaf: false });
    const join = useVoiceStore.getState().joinChannel('one', 'guild'); await flush();
    expect(useVoiceStore.getState().callPhase).toBe('joining');
    await useVoiceStore.getState().toggleMute();
    expect(useVoiceStore.getState().selfMute).toBe(false);
    pending.resolve(); await join;
    const transport = media.transport as unknown as { setMute: ReturnType<typeof vi.fn>; setDeaf: ReturnType<typeof vi.fn> };
    expect(useVoiceStore.getState().callPhase).toBe('connected');
    expect(useVoiceStore.getState().selfMute).toBe(false);
    expect(transport.setMute).toHaveBeenLastCalledWith(false);
    expect(transport.setDeaf).toHaveBeenLastCalledWith(false);
  });

  it('keeps a Mute pressed while the call is joining', async () => {
    const pending = deferred<void>(); const media = engine();
    media.connect.mockImplementation(() => pending.promise);
    fixture.factory.mockResolvedValue(media.transport);
    useVoiceStore.setState({ selfMute: false, selfDeaf: false });
    const join = useVoiceStore.getState().joinChannel('one', 'guild'); await flush();
    await useVoiceStore.getState().toggleMute();
    pending.resolve(); await join;
    const transport = media.transport as unknown as { setMute: ReturnType<typeof vi.fn> };
    expect(useVoiceStore.getState().selfMute).toBe(true);
    expect(transport.setMute).toHaveBeenLastCalledWith(true);
  });

  it('shares the pending join promise for the same account/channel', async () => {
    const pending = deferred<ReturnType<typeof response>>(); fixture.join.mockReturnValue(pending.promise);
    const first = useVoiceStore.getState().joinChannel('same', 'guild');
    const duplicate = useVoiceStore.getState().joinChannel('same', 'guild');
    expect(duplicate).toBe(first);
    pending.resolve(response()); await first;
    expect(fixture.join).toHaveBeenCalledTimes(1);
  });

  it('releases a late A receipt without clearing B or creating an A engine', async () => {
    const pending = deferred<ReturnType<typeof response>>(); fixture.join.mockReturnValueOnce(pending.promise);
    const first = useVoiceStore.getState().joinChannel('same', 'dm'); await flush();
    fixture.selected = 'B';
    await useVoiceStore.getState().joinChannel('same', 'dm');
    pending.resolve(response('old-A')); await first; await flush();
    expect(fixture.leave).toHaveBeenCalledWith('A', 'same', true, 'old-A');
    expect(useVoiceStore.getState().callScope?.serverId).toBe('B');
    expect(useVoiceStore.getState().connected).toBe(true);
    expect(fixture.factory).toHaveBeenCalledTimes(1);
  });

  it('owns the engine before connect and ignores its callbacks after replacement', async () => {
    const pending = deferred<void>(); const first = engine(); const second = engine();
    first.connect.mockImplementation(() => pending.promise);
    fixture.factory.mockResolvedValueOnce(first.transport).mockResolvedValueOnce(second.transport);
    const join = useVoiceStore.getState().joinChannel('one', 'guild'); await flush();
    await useVoiceStore.getState().joinChannel('two', 'guild');
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    first.callbacks.lost?.('old connection lost'); first.callbacks.join?.('stale-peer');
    pending.resolve(); await join;
    expect(useVoiceStore.getState().mediaEngine).toBe(second.transport);
    expect(useVoiceStore.getState().participants.has('stale-peer')).toBe(false);
  });

  it('retains A while browsing B, publishes only to A, and cancels on explicit disconnect A', async () => {
    const media = engine(); fixture.factory.mockResolvedValue(media.transport);
    await useVoiceStore.getState().joinChannel('one', 'guild');
    fixture.selected = 'B';
    useVoiceStore.getState().publishVoiceState();
    expect(fixture.publish.mock.calls[0]?.[0]).toBe('A');
    notifyServerDisconnected('B'); expect(useVoiceStore.getState().connected).toBe(true);
    notifyServerDisconnected('A'); await flush();
    expect(media.disconnect).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().connected).toBe(false);
  });

  it('keeps what the gateway said about a member when the engine reports them joining', async () => {
    // Joining a call "joins" everybody already in it at the media layer. Their
    // screen share, camera and mute come from the gateway and must survive
    // that, or the stage drops a share it was just asked to watch.
    const media = engine(); fixture.factory.mockResolvedValue(media.transport);
    useVoiceStore.getState().loadVoiceStates('guild', [{
      user_id: '7', channel_id: 'one', guild_id: 'guild', session_id: 'receipt-7', username: 'vincent',
      self_stream: true, self_video: true, self_mute: true, self_deaf: false, mute: false, deaf: false, suppress: false,
    }], { serverId: 'A', userId: '1' });
    await useVoiceStore.getState().joinChannel('one', 'guild');

    media.callbacks.join?.('7');

    expect(useVoiceStore.getState().participants.get('7')).toMatchObject({
      channel_id: 'one', session_id: 'receipt-7', username: 'vincent', self_stream: true, self_video: true, self_mute: true,
    });
  });

  it('keeps everybody else\'s name and sharing through a leave and a cold join', async () => {
    // Leaving drops the call's participants, while the channel's voice states
    // (the server's) stay. The engine of the next join reports everybody
    // already in the call before that call is committed; seating them from
    // nothing wrote nameless placeholders over what the server said, so the
    // pill read "Unknown user" and lost Watch.
    const first = engine(); const second = engine();
    fixture.factory.mockResolvedValueOnce(first.transport).mockResolvedValueOnce(second.transport);
    useVoiceStore.getState().loadVoiceStates('guild', [{
      user_id: '7', channel_id: 'one', guild_id: 'guild', session_id: 'receipt-7', username: 'vincent',
      self_stream: true, self_video: false, self_mute: false, self_deaf: false, mute: false, deaf: false, suppress: false,
    }], { serverId: 'A', userId: '1' });
    await useVoiceStore.getState().joinChannel('one', 'guild');
    await useVoiceStore.getState().leaveChannel(); await flush();
    expect(useVoiceStore.getState().participants.has('7')).toBe(false);

    second.connect.mockImplementation(async () => { second.callbacks.join?.('7'); });
    await useVoiceStore.getState().joinChannel('one', 'guild'); await flush();
    const expected = { channel_id: 'one', session_id: 'receipt-7', username: 'vincent', self_stream: true };
    expect(useVoiceStore.getState().participants.get('7')).toMatchObject(expected);
    expect(useVoiceStore.getState().channelParticipants.get('one')?.find((m) => m.user_id === '7')).toMatchObject(expected);
  });

  it('seats a member the gateway has not reported yet', async () => {
    const media = engine(); fixture.factory.mockResolvedValue(media.transport);
    await useVoiceStore.getState().joinChannel('one', 'guild');
    media.callbacks.join?.('8');
    expect(useVoiceStore.getState().participants.get('8')).toMatchObject({ channel_id: 'one', self_stream: false });
  });

  it('account reset cancels pending connect and cannot clear a replacement login', async () => {
    const pending = deferred<void>(); const first = engine(); const second = engine();
    first.connect.mockImplementation(() => pending.promise);
    fixture.factory.mockResolvedValueOnce(first.transport).mockResolvedValueOnce(second.transport);
    const join = useVoiceStore.getState().joinChannel('one', 'guild'); await flush();
    fixture.contexts[0]!.abort();
    fixture.user = '2';
    await useVoiceStore.getState().joinChannel('two', 'guild');
    pending.resolve(); await join;
    expect(useVoiceStore.getState().callScope).toEqual({ serverId: 'A', userId: '2' });
    expect(useVoiceStore.getState().participants.has('1')).toBe(false);
  });
});
