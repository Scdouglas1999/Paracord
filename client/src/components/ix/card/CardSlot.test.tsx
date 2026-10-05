import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetDeclinedCalls } from '../../../hooks/useIncomingDmCall';

import { entityScopeKey } from '../../../lib/serverScope';
import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useRemoteSpeakingStore } from '../../../stores/remoteSpeakingStore';
import { useToastStore } from '../../../stores/toastStore';
import { useTogetherStore } from '../../../stores/togetherStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { VoiceState } from '../../../types';
import { useJoinMuteStore } from '../../glass/pill/muteStore';
import { useListenBlockStore } from '../../glass/pill/pillActions';
import { CardSlot } from './CardSlot';
import { resetListenInForTests } from './listenIn';
import { MINUTE_TICK_MS, tickMinuteForTests } from './minuteTick';

/**
 * The card slot against the real stores (docs/index-spec.md §4.3, §4.10): which
 * card a place shows, what each state draws, and that every control calls the
 * existing voice action. How it looks and moves is held by e2e/index-card.spec.ts.
 */

const SCOPE = { serverId: '__local__', userId: 'me' };
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => SCOPE,
  useCurrentUser: () => ({ id: 'me', username: 'sean', display_name: 'Sean', avatar_hash: null }),
}));
vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:face') },
}));
const listenIn = vi.hoisted(() => ({ allowed: true }));
vi.mock('../../../api/voice', () => ({
  voiceApi: { getListenIn: vi.fn(async () => listenIn.allowed) },
}));

const T0 = Date.parse('2026-10-01T21:12:50-05:00');

function voiceState(userId: string, over: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId,
    channel_id: 'lounge',
    guild_id: 'g1',
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

const VINCENT = voiceState('vincent', { joined_at: new Date(T0).toISOString() });
const BRENDAN = voiceState('brendan', { joined_at: new Date(T0 + 20_000).toISOString() });

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

const actions = {
  listen: vi.fn(async () => {}),
  joinChannel: vi.fn(async () => {}),
  leaveChannel: vi.fn(async () => {}),
  toggleMute: vi.fn(async () => {
    useVoiceStore.setState((state) => ({ selfMute: !state.selfMute }));
  }),
  toggleVideo: vi.fn(async () => {}),
  publishVoiceState: vi.fn(),
};

function inCall(mode: 'joined' | 'listen', states: VoiceState[] = [VINCENT, BRENDAN], channelId = 'lounge', guildId = 'g1') {
  const me = voiceState('me', {
    mode,
    channel_id: channelId,
    guild_id: guildId === 'dm' ? undefined : guildId,
    joined_at: new Date(T0 + 60_000).toISOString(),
  });
  useVoiceStore.setState({
    callId: 'call-1',
    callScope: SCOPE,
    callPhase: 'connected',
    callMode: mode,
    connected: true,
    channelId,
    guildId,
    channelParticipants: new Map([[channelId, [...states, me]]]),
  });
}

const fuel = { kind: 'server' as const, guildId: 'g1' };
const elsewhere = { kind: 'server' as const, guildId: 'g2' };

function renderSlot(position: 'inline' | 'pinned', place: { kind: 'server'; guildId: string } | { kind: 'people' } = fuel) {
  return render(
    <MemoryRouter>
      <div className="ix-side__pinned">
        <CardSlot place={place} position={position} />
      </div>
    </MemoryRouter>,
  );
}

const DM = { ...channel('dm1', '', null, 1), recipient: { id: 'jeremy', username: 'jeremy', display_name: 'Jeremy' } };

const card = () => screen.getByTestId('ix-room-card');
const names = () => [...card().querySelectorAll('.ix-card-row__name')].map((name) => name.textContent);

beforeEach(() => {
  // A decline is shared by every place that rings (the card, the phone's call strip).
  forgetDeclinedCalls();
  vi.spyOn(Date, 'now').mockReturnValue(T0 + 34 * 60_000 + 5_000);
  listenIn.allowed = true;
  resetListenInForTests();
  useAuthStore.setState({ user: { id: 'me', username: 'sean', display_name: 'Sean', avatar_hash: null } } as never);
  useGlassStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  useTogetherStore.getState().reset();
  useListenBlockStore.setState({ blocked: {} });
  useJoinMuteStore.setState({ joinMuted: false });
  useRemoteSpeakingStore.setState({ byChannel: new Map() });
  useMemberStore.setState({ members: new Map() } as never);
  useGuildStore.setState({ guilds: [guild('g1', 'Game Night'), guild('g2', 'Fuel')] } as never);
  useChannelStore.setState({
    channelsById: {
      [entityScopeKey(SCOPE, 'lounge')]: channel('lounge', 'Lounge', 'g1'),
      [entityScopeKey(SCOPE, 'stage')]: channel('stage', 'Town hall', 'g1', 13),
      [entityScopeKey(SCOPE, 'dm1')]: DM,
    },
    // The account's own view (direct messages are filed under no server).
    channelsByGuild: { [entityScopeKey(SCOPE, '')]: [DM] },
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
    selfVideo: false,
    selfStream: false,
    modeSwitching: false,
    modeError: null,
    connectionError: null,
    connectionErrorChannelId: null,
    connectionErrorCode: null,
    channelParticipants: new Map(),
    participants: new Map(),
    speakingUsers: new Set(),
    watchers: new Map(),
    watchView: null,
    systemAudioCaptureActive: false,
    mediaEngine: null,
  });
  for (const fn of Object.values(actions)) fn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the inline card', () => {
  it('is an empty slot when nothing is live, and the busiest room when something is', async () => {
    const { container } = renderSlot('inline');
    expect(container.querySelector('.ix-card-slot')).toBeEmptyDOMElement();
    act(() => useVoiceStore.setState({ channelParticipants: new Map([['lounge', [VINCENT, BRENDAN]]]) }));
    expect(card()).toHaveAttribute('data-state', 'live');
    expect(card()).toHaveAccessibleName('Lounge, live 34 min, 2 people');
    expect(within(card()).getByText('live 34 min')).toBeInTheDocument();
    expect(names()).toEqual(['Vincent', 'Brendan']);
    // Listen appears once the server says the room admits listeners.
    expect(await within(card()).findByTestId('ix-card-listen')).toHaveAccessibleName('Listen in to Lounge');
  });

  it('says what a room you are not in plays together, under the head', () => {
    useVoiceStore.setState({ channelParticipants: new Map([['lounge', [VINCENT, BRENDAN]]]) });
    renderSlot('inline');
    expect(card().querySelector('.ix-room-card__line')).toBeNull();
    const activity = {
      session_id: 's1',
      kind: 'watch' as const,
      started_by: 'vincent',
      playing: true,
      title: 'Big Buck Bunny',
      source: 'url' as const,
      thumbnail: null,
      item_count: 1,
    };
    act(() => useTogetherStore.getState().applyActivityUpdate({ guild_id: 'g1', channel_id: 'lounge', revision: 1, activity }));
    expect(within(card()).getByText('Watching Big Buck Bunny')).toHaveClass('ix-room-card__line');
    act(() =>
      useTogetherStore.getState().applyActivityUpdate({ guild_id: 'g1', channel_id: 'lounge', revision: 2, activity: { ...activity, kind: 'listen', title: null } }),
    );
    expect(within(card()).getByText('Listening together')).toBeInTheDocument();
    act(() => useTogetherStore.getState().applyActivityUpdate({ guild_id: 'g1', channel_id: 'lounge', revision: 3, activity: null }));
    expect(card().querySelector('.ix-room-card__line')).toBeNull();
  });

  it('Join and Listen call the voice store (Join applies the mute preference first)', async () => {
    useJoinMuteStore.setState({ joinMuted: true });
    useVoiceStore.setState({ channelParticipants: new Map([['lounge', [VINCENT]]]) });
    renderSlot('inline');
    await act(async () => fireEvent.click(screen.getByTestId('ix-card-join')));
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(actions.joinChannel).toHaveBeenCalledWith('lounge', 'g1');
    await act(async () => fireEvent.click(await screen.findByTestId('ix-card-listen')));
    expect(actions.listen).toHaveBeenCalledWith('lounge', 'g1');
  });

  it('a room that does not admit listeners has no Listen control', async () => {
    listenIn.allowed = false;
    useVoiceStore.setState({ channelParticipants: new Map([['lounge', [VINCENT]]]) });
    renderSlot('inline');
    await waitFor(() => expect(screen.getByTestId('ix-card-join')).toBeInTheDocument());
    await act(async () => {});
    expect(screen.queryByTestId('ix-card-listen')).toBeNull();
  });

  it('someone streaming: Join is the wide control and Watch <name> the cream one, which opens the call view on the stream', () => {
    useVoiceStore.setState({ channelParticipants: new Map([['lounge', [BRENDAN, { ...VINCENT, self_stream: true }]]]) });
    renderSlot('inline');
    expect(card()).toHaveAttribute('data-state', 'streaming');
    expect(within(card()).getAllByRole('listitem')[0]).toHaveTextContent('Vincent');
    fireEvent.click(screen.getByTestId('ix-card-watch'));
    expect(screen.getByTestId('ix-card-watch')).toHaveTextContent('Watch Vincent');
    expect(useGlassStore.getState().stage).toMatchObject({ channelId: 'lounge', guildId: 'g1', streamerId: 'vincent' });
    expect(useVoiceStore.getState().callId).toBeNull();
    expect(screen.getByTestId('ix-card-join')).toHaveClass('ix-ctl--wide');
    // The screen glyph on the streamer's row opens the same stream.
    useGlassStore.getState().closeStage();
    fireEvent.click(screen.getByRole('button', { name: "Watch Vincent's screen" }));
    expect(useGlassStore.getState().stage.streamerId).toBe('vincent');
  });

  it('listening: the Listen control is on, "You — listening", and Join upgrades', async () => {
    inCall('listen');
    useVoiceStore.setState((state) => ({ channelParticipants: new Map([['lounge', state.channelParticipants.get('lounge')!.map((s) => (s.user_id === 'me' ? { ...s, mode: 'listen' as const } : s))]]) }));
    renderSlot('inline');
    expect(card()).toHaveAttribute('data-state', 'listening');
    expect(within(card()).getByText('Listening')).toBeInTheDocument();
    expect(within(card()).getByText('You — listening')).toBeInTheDocument();
    const listen = screen.getByTestId('ix-card-listen');
    expect(listen).toHaveAttribute('aria-pressed', 'true');
    await act(async () => fireEvent.click(listen));
    expect(actions.leaveChannel).toHaveBeenCalled();
  });

  it('talking: the row says so, the waveform is drawn only while talking, real levels in your call', () => {
    useRemoteSpeakingStore.setState({ byChannel: new Map([['g1:lounge', new Set(['vincent'])]]) });
    useVoiceStore.setState({ channelParticipants: new Map([['lounge', [VINCENT, BRENDAN]]]) });
    renderSlot('inline');
    const [vincent, brendan] = within(card()).getAllByRole('listitem');
    expect(vincent).toHaveAttribute('data-talking', 'true');
    expect(vincent.querySelector('.ix-wave')).not.toHaveAttribute('data-real');
    expect(brendan.querySelector('.ix-wave')).toBeNull();
    expect(card()).toHaveAccessibleName('Lounge, live 34 min, 2 people, Vincent talking');
    act(() => useRemoteSpeakingStore.setState({ byChannel: new Map() }));
    expect(vincent).toHaveAttribute('data-talking', 'false');
    expect(vincent.querySelector('.ix-wave')).toBeNull();
  });
});

describe('your card', () => {
  it('mic, camera, screen, Open call / Back to chat and Leave call the existing actions', async () => {
    inCall('joined');
    useVoiceStore.setState({ speakingUsers: new Set(['vincent']) });
    renderSlot('inline');
    expect(card()).toHaveAttribute('data-state', 'yours');
    expect(within(card()).getByText('You’re in')).toBeInTheDocument();
    expect(names()).toEqual(['Vincent', 'Brendan', 'You']);
    // The engine hears the call: the waveform follows the real level.
    expect(card().querySelector('.ix-wave')).toHaveAttribute('data-real', '');
    expect(card().querySelector('.ix-wave')).toHaveAttribute('data-motion-speaking', 'vincent');

    await act(async () => fireEvent.click(screen.getByTestId('ix-card-mic')));
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ix-card-mic')).toHaveAccessibleName('Unmute');
    await act(async () => fireEvent.click(screen.getByTestId('ix-card-camera')));
    expect(actions.toggleVideo).toHaveBeenCalledTimes(1);

    const open = screen.getByTestId('ix-card-open-call');
    expect(open).toHaveAccessibleName('Open call');
    fireEvent.click(open);
    expect(useGlassStore.getState().stage).toMatchObject({ channelId: 'lounge', streamerId: null });
    expect(open).toHaveAccessibleName('Back to chat');
    fireEvent.click(open);
    expect(useGlassStore.getState().stage.mode).toBe('none');

    await act(async () => fireEvent.click(screen.getByTestId('ix-card-leave')));
    expect(actions.leaveChannel).toHaveBeenCalledTimes(1);
  });

  it('right-click on the mic opens the device menu', () => {
    inCall('joined');
    renderSlot('inline');
    fireEvent.contextMenu(screen.getByTestId('ix-card-mic'));
    expect(screen.getByTestId('ix-card-mic')).toHaveAttribute('aria-expanded', 'true');
  });

  it('is pinned in another place with its server line, and only there', () => {
    inCall('joined');
    const inline = renderSlot('inline', elsewhere);
    expect(inline.container.querySelector('[data-testid="ix-room-card"]')).toBeNull();
    inline.unmount();
    const pinned = renderSlot('pinned', elsewhere);
    expect(card()).toHaveAttribute('data-position', 'pinned');
    expect(within(card()).getByText('Game Night')).toHaveClass('ix-room-card__from');
    pinned.unmount();
    // In its own place the pinned slot is null (the host collapses).
    const own = renderSlot('pinned', fuel);
    expect(own.container.querySelector('.ix-side__pinned')).toBeEmptyDOMElement();
  });

  it('a stage audience has no microphone, camera or screen; a stage room has no Listen', () => {
    useVoiceStore.setState({ channelParticipants: new Map([['stage', [voiceState('ada', { channel_id: 'stage' })]]]) });
    const view = renderSlot('inline');
    expect(screen.queryByTestId('ix-card-listen')).toBeNull();
    view.unmount();
    inCall('joined', [voiceState('ada', { channel_id: 'stage' })], 'stage');
    useVoiceStore.setState((state) => ({
      channelParticipants: new Map([['stage', state.channelParticipants.get('stage')!.map((s) => ({ ...s, suppress: true }))]]),
    }));
    renderSlot('inline');
    expect(screen.queryByTestId('ix-card-mic')).toBeNull();
    expect(screen.getByTestId('ix-card-open-call')).toBeInTheDocument();
    expect(screen.getByTestId('ix-card-leave')).toBeInTheDocument();
  });

  it('a DM call is People’s card, named for the person, with no Listen', () => {
    inCall('joined', [voiceState('jeremy', { channel_id: 'dm1', guild_id: undefined })], 'dm1', 'dm');
    renderSlot('inline', { kind: 'people' });
    expect(card()).toHaveAttribute('data-state', 'yours');
    expect(within(card()).getByText('Jeremy', { selector: '.ix-room-card__title' })).toBeInTheDocument();
    expect(screen.queryByTestId('ix-card-listen')).toBeNull();
  });
});

describe('an incoming DM call', () => {
  it('rings in the pinned slot with Decline and Accept; Decline dismisses it locally', async () => {
    useVoiceStore.setState({ channelParticipants: new Map([['dm1', [voiceState('jeremy', { channel_id: 'dm1', guild_id: undefined })]]]) });
    renderSlot('pinned', elsewhere);
    expect(card()).toHaveAttribute('data-state', 'incoming');
    expect(within(card()).getByText('Jeremy is calling')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ix-card-decline'));
    await waitFor(() => expect(screen.queryByTestId('ix-room-card')).toBeNull());
    expect(actions.joinChannel).not.toHaveBeenCalled();
  });

  it('Accept joins the DM call', async () => {
    useVoiceStore.setState({ channelParticipants: new Map([['dm1', [voiceState('jeremy', { channel_id: 'dm1', guild_id: undefined })]]]) });
    renderSlot('pinned', elsewhere);
    await act(async () => fireEvent.click(screen.getByTestId('ix-card-accept')));
    expect(actions.joinChannel).toHaveBeenCalledWith('dm1', 'dm');
  });
});

describe('the minute tick', () => {
  it('is one 60 000 ms interval that refreshes "live N min"', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    useVoiceStore.setState({ channelParticipants: new Map([['lounge', [VINCENT]]]) });
    renderSlot('inline');
    expect(spy.mock.calls.some(([, ms]) => ms === MINUTE_TICK_MS)).toBe(true);
    expect(MINUTE_TICK_MS).toBe(60_000);
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 61 * 60_000);
    act(() => tickMinuteForTests());
    expect(within(card()).getByText('live 1 hr 1 min')).toBeInTheDocument();
  });
});
