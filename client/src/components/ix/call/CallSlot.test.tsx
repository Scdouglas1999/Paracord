import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import { entityScopeKey } from '../../../lib/serverScope';
import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore, type StageTarget } from '../../../stores/glassStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useRemoteSpeakingStore } from '../../../stores/remoteSpeakingStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { VoiceState } from '../../../types';
import { useJoinMuteStore } from '../../glass/pill/muteStore';
import { IxShellProvider } from '../shell/IxShellContext';
import { CallSlot } from './CallSlot';

/**
 * The call view against the real stores (docs/index-spec.md §7): what each
 * state draws, the controls by state (joined / watching / stage audience), the
 * keys, the focus rules, and that closing the view unsubscribes every video
 * while the call goes on. How it looks and moves: e2e/index-call.spec.ts.
 */

const SCOPE = { serverId: '__local__', userId: 'me' };
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => SCOPE,
  useCurrentUser: () => ({ id: 'me', username: 'sean', display_name: 'Sean', avatar_hash: null }),
}));
vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:face') },
}));
// The conversation and the stream chrome have their own suites.
vi.mock('../../message/MessageList', () => ({
  MessageList: ({ channelId }: { channelId: string }) => <div data-testid="message-list" data-channel={channelId} />,
}));
vi.mock('../../message/MessageInput', () => ({
  MessageInput: ({ channelId, narrow }: { channelId: string; narrow?: boolean }) => (
    <div data-testid="message-input" data-channel={channelId} data-narrow={narrow ? 'true' : undefined} />
  ),
}));
vi.mock('../../glass/stage/StageChannelPanel', () => ({
  StageChannelPanel: () => <div data-testid="stage-panel" />,
}));
vi.mock('../../glass/stage/ClipToast', () => ({ ClipToast: () => null }));
vi.mock('../../glass/stage/SurfacingMessages', () => ({
  SurfacingMessages: ({ active }: { active: boolean }) => (active ? <div data-testid="surfacing" /> : null),
}));
const clip = vi.hoisted(() => ({ triggerClip: vi.fn(async () => true) }));
vi.mock('../../../lib/media/clips/useClip', () => ({
  useClip: () => ({ available: true, unavailableReason: null, saving: false, clip: vi.fn(async () => {}) }),
  triggerClip: clip.triggerClip,
}));

const T0 = Date.parse('2026-10-01T21:44:10-05:00');

function voiceState(userId: string, over: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId,
    channel_id: 'general',
    guild_id: 'fuel',
    session_id: `s-${userId}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    username: userId,
    display_name: userId[0].toUpperCase() + userId.slice(1),
    avatar_hash: null,
    mode: 'joined',
    joined_at: new Date(T0).toISOString(),
    ...over,
  };
}

const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const JEREMY = voiceState('jeremy', { joined_at: at(0) });
const ME = voiceState('me', { joined_at: at(60) });

const guild = (id: string, name: string) => ({ key: entityScopeKey(SCOPE, id), id, name, scope: SCOPE, originServerId: SCOPE.serverId });
const channel = (id: string, name: string, guildId: string | null, type = 2) => ({
  id,
  name,
  guild_id: guildId,
  type,
  channel_type: type,
  position: 0,
  key: entityScopeKey(SCOPE, id),
  scope: SCOPE,
});

const GENERAL: StageTarget = { serverId: SCOPE.serverId, guildId: 'fuel', channelId: 'general', streamerId: null };

const actions = {
  joinChannel: vi.fn(async () => {}),
  leaveChannel: vi.fn(async () => {}),
  toggleMute: vi.fn(async () => {
    useVoiceStore.setState((state) => ({ selfMute: !state.selfMute }));
  }),
  toggleVideo: vi.fn(async () => {}),
  startWatch: vi.fn(async (target: { channelId: string; streamerId: string }) => {
    useVoiceStore.setState({
      watchView: {
        id: 'w',
        kind: 'watch',
        scope: SCOPE,
        guildId: 'fuel',
        channelId: target.channelId,
        streamerId: target.streamerId,
        route: 'call',
        phase: 'live',
        engine: engine.api,
        sessionId: 'v',
        endReason: null,
        error: null,
      },
    } as never);
  }),
  stopWatch: vi.fn(async () => {
    useVoiceStore.setState({ watchView: null });
  }),
  fetchWatchers: vi.fn(async () => {}),
  publishVoiceState: vi.fn(),
};

/** An engine that remembers who is subscribed, by user and track. */
const engine = vi.hoisted(() => {
  const live = new Map<string, number>();
  const unsubscribed: string[] = [];
  const asked = new Map<string, unknown>();
  const api = {
    subscribeVideo: (userId: string, _canvas: HTMLCanvasElement, _onFrame?: () => void, options?: { preferredTrackId?: string }) => {
      const key = `${userId}:${options?.preferredTrackId ?? 'screen'}`;
      asked.set(key, options);
      live.set(key, (live.get(key) ?? 0) + 1);
      return () => {
        live.set(key, (live.get(key) ?? 1) - 1);
        unsubscribed.push(key);
      };
    },
    listPublishedTracks: async () => [],
    registerTrackSubscription: async () => {},
    supportsNativeSourcePicker: () => false,
  };
  return {
    api: api as unknown as MediaEngine,
    live,
    unsubscribed,
    /** The options a subscription was made with. */
    optionsOf: (key: string) => asked.get(key),
    subscribed: () => [...live.entries()].filter(([, count]) => count > 0).map(([key]) => key).sort(),
  };
});

function holdCall(states: VoiceState[] = [JEREMY, ME], mode: 'joined' | 'listen' = 'joined', channelId = 'general') {
  useVoiceStore.setState({
    callId: 'call-1',
    callScope: SCOPE,
    callPhase: 'connected',
    callMode: mode,
    connected: true,
    channelId,
    guildId: 'fuel',
    mediaEngine: engine.api,
    channelParticipants: new Map([[channelId, states]]),
  });
}

function renderSlot(layout: 'wide' | 'phone' = 'wide') {
  return render(
    <MemoryRouter>
      <IxShellProvider value={{ layout, place: { kind: 'server', guildId: 'fuel' }, guildId: 'fuel', channelId: 'plans' }}>
        <div id="ix-call-host">
          <CallSlot />
        </div>
      </IxShellProvider>
    </MemoryRouter>,
  );
}

const view = () => screen.getByTestId('ix-call');
const controls = () => within(view()).getByRole('group', { name: 'Call controls' });
const controlNames = () => within(controls()).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent);
const tileNames = () => [...view().querySelectorAll('.ix-call-grid .ix-call-tile__who')].map((name) => name.textContent);
const press = (key: string) => fireEvent.keyDown(document.body, { key });

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(T0 + 5 * 60_000);
  engine.live.clear();
  engine.unsubscribed.length = 0;
  useAuthStore.setState({ user: { id: 'me', username: 'sean', display_name: 'Sean', avatar_hash: null } } as never);
  useGlassStore.getState().reset();
  useJoinMuteStore.setState({ joinMuted: false });
  useRemoteSpeakingStore.setState({ byChannel: new Map() });
  useMemberStore.setState({ members: new Map() } as never);
  useGuildStore.setState({ guilds: [guild('fuel', 'Fuel')] } as never);
  useChannelStore.setState({
    channelsById: {
      [entityScopeKey(SCOPE, 'general')]: channel('general', 'General', 'fuel'),
      [entityScopeKey(SCOPE, 'hall')]: channel('hall', 'Town hall', 'fuel', 13),
    },
  } as never);
  useVoiceStore.setState({
    ...actions,
    callId: null,
    callScope: null,
    callPhase: 'idle',
    callMode: null,
    connected: false,
    channelId: null,
    guildId: null,
    selfMute: false,
    selfDeaf: false,
    selfVideo: false,
    selfStream: false,
    modeSwitching: false,
    channelParticipants: new Map(),
    participants: new Map(),
    speakingUsers: new Set(),
    watchers: new Map(),
    watchView: null,
    mediaEngine: null,
  } as never);
  for (const fn of Object.values(actions)) fn.mockClear();
  clip.triggerClip.mockClear();
});

afterEach(() => {
  act(() => useGlassStore.getState().reset());
  vi.restoreAllMocks();
});

describe('IX-13 call view', () => {
  it('renders nothing while no call view is open', () => {
    holdCall();
    const { container } = renderSlot();
    expect(container.querySelector('#ix-call-host')).toBeEmptyDOMElement();
  });

  it('open on the call: "Call: General", the server in the header, everyone as tiles in join order, the joined controls', () => {
    holdCall([ME, JEREMY]);
    renderSlot();
    act(() => useGlassStore.getState().openStage(GENERAL));
    expect(screen.getByRole('region', { name: 'Call: General' })).toBe(view());
    expect(within(view()).getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(view().querySelector('.ix-call-head__place')).toHaveTextContent('Fuel');
    expect(within(view()).getByTestId('ix-call-back')).toHaveTextContent('Back to chat');
    // Jeremy joined first; the voice store's list order never decides.
    expect(tileNames()).toEqual(['Jeremy', 'You']);
    expect(controlNames()).toEqual(['Microphone', 'Camera', 'Share your screen', 'More call actions', 'Leave General']);
    expect(within(controls()).getByTestId('ix-call-leave')).toHaveTextContent('Leave');
  });

  it('the controls work the existing actions: mic, Leave; Leave closes the view', async () => {
    holdCall();
    renderSlot();
    act(() => useGlassStore.getState().openStage(GENERAL));
    const mic = within(controls()).getByRole('button', { name: 'Microphone' });
    expect(mic).toHaveAttribute('aria-pressed', 'true');
    await act(async () => fireEvent.click(mic));
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(mic).toHaveAttribute('aria-pressed', 'false');

    await act(async () => fireEvent.click(within(controls()).getByTestId('ix-call-leave')));
    expect(actions.leaveChannel).toHaveBeenCalledTimes(1);
    act(() => useVoiceStore.setState({ callId: null, callPhase: 'idle', connected: false, channelId: null, channelParticipants: new Map([['general', [JEREMY]]]) }));
    expect(useGlassStore.getState().stage.mode).toBe('none');
    expect(screen.queryByTestId('ix-call')).toBeNull();
  });

  it('the mic menu (right-click) has Deafen; More lists the call\'s other actions', () => {
    holdCall();
    renderSlot();
    act(() => useGlassStore.getState().openStage(GENERAL));
    act(() => {
      fireEvent.contextMenu(within(controls()).getByRole('button', { name: 'Microphone' }));
    });
    const devices = screen.getByRole('dialog', { name: 'Microphone and speaker' });
    expect(within(devices).getByRole('button', { name: /Deafen/ })).toBeInTheDocument();
    act(() => fireEvent.click(within(controls()).getByRole('button', { name: 'More call actions' })));
    const more = screen.getByRole('menu', { name: 'More call actions' });
    const items = within(more).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(expect.arrayContaining(['Microphone and speaker', 'Connection check']));
    expect(items.some((item) => item?.startsWith('Share quality'))).toBe(true);
    // No stream in focus: nothing about a stream's sound.
    expect(items).not.toContain('Stream volume and quality');
  });

  it('watching without joining: the stream in focus above the filmstrip, Clip and Join', async () => {
    useVoiceStore.setState({ channelParticipants: new Map([['general', [JEREMY, voiceState('vincent', { joined_at: at(10), self_stream: true, self_stream_started_at: at(20) })]]]) });
    renderSlot();
    act(() => useGlassStore.getState().openStage({ ...GENERAL, streamerId: 'vincent' }));
    expect(view()).toHaveAttribute('data-focus', 'stream');
    expect(actions.startWatch).toHaveBeenCalledWith(expect.objectContaining({ streamerId: 'vincent', channelId: 'general' }));
    expect(view().querySelector('.ix-call-stream')).not.toBeNull();
    expect(within(view()).getByText("Vincent's screen")).toBeInTheDocument();
    expect(view().querySelectorAll('.ix-call-strip .ix-call-tile')).toHaveLength(2);
    expect(controlNames()).toEqual(['Clip', 'Join General']);
    await act(async () => fireEvent.click(within(controls()).getByRole('button', { name: 'Join General' })));
    expect(actions.joinChannel).toHaveBeenCalledTimes(1);
    // Joining from watch keeps the view open (§7.3).
    expect(useGlassStore.getState().stage.streamerId).toBe('vincent');
  });

  it('somebody shares: their stream comes into focus; Show everyone puts it away for this view', () => {
    holdCall([JEREMY, voiceState('vincent', { joined_at: at(10), self_stream: true, self_stream_started_at: at(20) }), ME]);
    renderSlot();
    act(() => useGlassStore.getState().openStage(GENERAL));
    expect(useGlassStore.getState().stage.streamerId).toBe('vincent');
    expect(view()).toHaveAttribute('data-focus', 'stream');
    expect(controlNames()).toContain('Clip');
    act(() => fireEvent.click(within(view()).getByRole('button', { name: 'Show everyone' })));
    expect(useGlassStore.getState().stage.streamerId).toBeNull();
    expect(view()).toHaveAttribute('data-focus', 'grid');
    expect(actions.stopWatch).toHaveBeenCalled();
    // A click on the sharer's tile focuses the stream again.
    act(() => fireEvent.click(within(view()).getByRole('button', { name: "Watch Vincent's screen" })));
    expect(useGlassStore.getState().stage.streamerId).toBe('vincent');
  });

  it('a camera is drawn cropped from about a third down, so faces stay in frame', () => {
    holdCall([JEREMY, voiceState('brendan', { joined_at: at(5), self_video: true }), ME]);
    renderSlot();
    act(() => useGlassStore.getState().openStage(GENERAL));
    // A portrait camera in a wide tile loses its bottom first, not its forehead.
    expect(engine.optionsOf('brendan:camera')).toEqual({
      preferredTrackId: 'camera',
      fit: 'cover',
      anchor: { x: 0.5, y: 0.35 },
    });
  });

  it('a camera in the grid focuses on a click; the other people go to the filmstrip', () => {
    holdCall([JEREMY, voiceState('brendan', { joined_at: at(5), self_video: true }), ME]);
    renderSlot();
    act(() => useGlassStore.getState().openStage(GENERAL));
    expect(engine.subscribed()).toEqual(['brendan:camera']);
    act(() => fireEvent.click(within(view()).getByRole('button', { name: "Focus Brendan's camera" })));
    expect(view()).toHaveAttribute('data-focus', 'camera');
    expect(view().querySelectorAll('.ix-call-strip .ix-call-tile')).toHaveLength(2);
    // One subscription of the camera, now in focus.
    expect(engine.subscribed()).toEqual(['brendan:camera']);
    act(() => fireEvent.click(within(view()).getByRole('button', { name: 'Show everyone' })));
    expect(view()).toHaveAttribute('data-focus', 'grid');
  });

  it('closing the view unsubscribes every video and stops the watch; the call goes on', () => {
    holdCall([
      voiceState('brendan', { joined_at: at(5), self_video: true }),
      voiceState('vincent', { joined_at: at(10), self_stream: true, self_stream_started_at: at(20) }),
      ME,
    ]);
    renderSlot();
    act(() => useGlassStore.getState().openStage(GENERAL));
    expect(useGlassStore.getState().stage.streamerId).toBe('vincent');
    expect(engine.subscribed()).toEqual(['brendan:camera', 'vincent:screen']);
    act(() => fireEvent.click(within(view()).getByTestId('ix-call-back')));
    expect(useGlassStore.getState().stage.mode).toBe('none');
    expect(screen.queryByTestId('ix-call')).toBeNull();
    expect(engine.subscribed()).toEqual([]);
    expect(engine.unsubscribed).toEqual(expect.arrayContaining(['brendan:camera', 'vincent:screen']));
    expect(actions.stopWatch).toHaveBeenCalled();
    expect(actions.leaveChannel).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().connected).toBe(true);
  });

  it('keys: T theater, H the chat column (the call\'s own channel), C clips a stream, Esc theater -> main -> closed', () => {
    holdCall([JEREMY, voiceState('vincent', { joined_at: at(10), self_stream: true, self_stream_started_at: at(20) }), ME]);
    renderSlot();
    act(() => useGlassStore.getState().openStage(GENERAL));
    act(() => press('t'));
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    expect(view()).toHaveAttribute('data-mode', 'theater');
    // Theater with the chat off: new messages surface over the stream.
    expect(screen.getByTestId('surfacing')).toBeInTheDocument();
    act(() => press('h'));
    const chat = within(view()).getByRole('complementary', { name: 'Chat in General' });
    expect(within(chat).getByTestId('message-list')).toHaveAttribute('data-channel', 'general');
    expect(within(chat).getByTestId('message-input')).toHaveAttribute('data-narrow', 'true');
    expect(screen.queryByTestId('surfacing')).toBeNull();
    expect(within(view()).getByTestId('ix-call-chat')).toHaveAttribute('aria-pressed', 'true');
    act(() => press('c'));
    expect(clip.triggerClip).toHaveBeenCalledTimes(1);
    act(() => press('Escape'));
    expect(useGlassStore.getState().stage.mode).toBe('main');
    act(() => press('Escape'));
    expect(useGlassStore.getState().stage.mode).toBe('none');
  });

  it('a stage channel: speakers are tiles, the audience one "N listening" row, and Request to speak', () => {
    const speaker = voiceState('maya', { channel_id: 'hall', joined_at: at(0) });
    const audience = ['nick', 'vincent'].map((id, index) => voiceState(id, { channel_id: 'hall', joined_at: at(10 + index), suppress: true }));
    const me = voiceState('me', { channel_id: 'hall', joined_at: at(30), suppress: true });
    holdCall([speaker, ...audience, me], 'joined', 'hall');
    renderSlot();
    act(() => useGlassStore.getState().openStage({ ...GENERAL, channelId: 'hall' }));
    expect(tileNames()).toEqual(['Maya']);
    expect(within(view()).getByRole('group', { name: /^3 listening/ })).toBeInTheDocument();
    expect(controlNames()).toEqual(['Request to speak', 'More call actions', 'Leave Town hall']);
    act(() => press('h'));
    expect(within(view()).getByTestId('stage-panel')).toBeInTheDocument();
  });

  it('a direct call says "Direct call" and is named for the person', () => {
    useChannelStore.setState({
      channelsById: {
        [entityScopeKey(SCOPE, 'dm1')]: { ...channel('dm1', '', null, 1), recipient: { id: 'jeremy', username: 'jeremy', display_name: 'Jeremy' } },
      },
    } as never);
    holdCall([voiceState('jeremy', { channel_id: 'dm1', guild_id: undefined }), voiceState('me', { channel_id: 'dm1', guild_id: undefined, joined_at: at(5) })], 'joined', 'dm1');
    useVoiceStore.setState({ guildId: 'dm' });
    renderSlot();
    act(() => useGlassStore.getState().openStage({ serverId: SCOPE.serverId, guildId: null, channelId: 'dm1', streamerId: null }));
    expect(screen.getByRole('region', { name: 'Call: Jeremy' })).toBeInTheDocument();
    expect(view().querySelector('.ix-call-head__place')).toHaveTextContent('Direct call');
  });

  it('on a phone: no chat column and no theater', () => {
    holdCall();
    renderSlot('phone');
    act(() => useGlassStore.getState().openStage(GENERAL));
    expect(within(view()).queryByTestId('ix-call-chat')).toBeNull();
    expect(within(view()).queryByTestId('ix-call-theater')).toBeNull();
    act(() => press('t'));
    act(() => press('h'));
    expect(useGlassStore.getState().stage.mode).toBe('main');
    expect(within(view()).queryByRole('complementary')).toBeNull();
  });
});
