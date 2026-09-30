import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useRemoteSpeakingStore } from '../../../stores/remoteSpeakingStore';
import { useToastStore } from '../../../stores/toastStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { VoiceState } from '../../../types';
import { CallPill } from './CallPill';
import { useJoinMuteStore } from './muteStore';
import { useListenBlockStore } from './pillActions';

/**
 * The call pill (docs/glass-spec.md §5, §7, §8, §9). What it draws is held by
 * the screenshots (docs/design/glass-g12-checkpoint.md); this suite holds what
 * the buttons do, what each state says, and that every control is named.
 */

const SCOPE = { serverId: '__local__', userId: 'me' };
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => SCOPE,
  useCurrentUser: () => ({ id: 'me', username: 'sean', display_name: 'Sean', avatar_hash: null }),
}));
vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:face') },
}));

const frames = vi.hoisted(() => ({
  subscribe: vi.fn(),
}));
vi.mock('../../../stores/voice/viewFrames', () => ({
  subscribeViewFrames: (...args: unknown[]) => frames.subscribe(...args),
}));

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
    ...over,
  };
}

const VINCENT = voiceState('vincent', { self_stream: true });
const BRENDAN = voiceState('brendan');
const NICK = voiceState('nick', { self_mute: true });

const guild = (id: string, name: string) => ({
  key: entityScopeKey(SCOPE, id),
  id,
  name,
  scope: SCOPE,
  originServerId: SCOPE.serverId,
});

const channel = (id: string, name: string, guildId: string) => ({
  id,
  name,
  guild_id: guildId,
  type: 2,
  channel_type: 2,
  position: 0,
  key: entityScopeKey(SCOPE, id),
  scope: SCOPE,
});

type Actions = Pick<
  ReturnType<typeof useVoiceStore.getState>,
  'listen' | 'joinChannel' | 'leaveChannel' | 'toggleMute'
>;
const original: Actions = {
  listen: useVoiceStore.getState().listen,
  joinChannel: useVoiceStore.getState().joinChannel,
  leaveChannel: useVoiceStore.getState().leaveChannel,
  toggleMute: useVoiceStore.getState().toggleMute,
};

const actions = {
  listen: vi.fn(async () => {}),
  joinChannel: vi.fn(async () => {}),
  leaveChannel: vi.fn(async () => {}),
  // Flips the preference the way the store does, without a call.
  toggleMute: vi.fn(async () => {
    useVoiceStore.setState((state) => ({ selfMute: !state.selfMute }));
  }),
};

function live(states: VoiceState[] = [VINCENT, BRENDAN, NICK]) {
  useVoiceStore.setState({ channelParticipants: new Map([['lounge', states]]) });
}

/** This client in the Lounge's call, as `voiceStore` holds it after a join. */
function inCall(mode: 'joined' | 'listen', over: Partial<ReturnType<typeof useVoiceStore.getState>> = {}) {
  const me = voiceState('me', { mode, self_mute: mode === 'listen' });
  useVoiceStore.setState({
    callId: 'call-1',
    callScope: SCOPE,
    callPhase: 'connected',
    callMode: mode,
    connected: true,
    channelId: 'lounge',
    guildId: 'g1',
    selfMute: mode === 'listen',
    channelParticipants: new Map([['lounge', [VINCENT, BRENDAN, NICK, me]]]),
    ...over,
  });
}

function renderPill(guildId: string | null = 'g1', layout: 'row' | 'stacked' = 'row') {
  return render(
    <div className="glass-header__pill" data-testid="slot">
      <CallPill guildId={guildId} layout={layout} />
    </div>,
  );
}

const region = () => screen.getByRole('region', { name: /live voice channel|voice call/ });

beforeEach(() => {
  useGlassStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  useListenBlockStore.setState({ blocked: {} });
  useJoinMuteStore.setState({ joinMuted: true });
  useRemoteSpeakingStore.setState({ byChannel: new Map() });
  useMemberStore.setState({ members: new Map() } as never);
  useGuildStore.setState({ guilds: [guild('g1', 'Game Night'), guild('g2', 'Basecamp')] } as never);
  useChannelStore.setState({
    channelsById: {
      [entityScopeKey(SCOPE, 'lounge')]: channel('lounge', 'Lounge', 'g1'),
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
    modeSwitching: false,
    modeError: null,
    connectionError: null,
    connectionErrorChannelId: null,
    connectionErrorCode: null,
    channelParticipants: new Map(),
    participants: new Map(),
    speakingUsers: new Set(),
    watchView: null,
    ambientView: null,
  });
  for (const fn of Object.values(actions)) fn.mockClear();
  actions.toggleMute.mockImplementation(async () => {
    useVoiceStore.setState((state) => ({ selfMute: !state.selfMute }));
  });
  frames.subscribe.mockReset();
  frames.subscribe.mockReturnValue(() => {});
});

afterEach(() => {
  useVoiceStore.setState({ ...original });
});

describe('when it draws', () => {
  it('draws nothing when nothing is live and there is no call, so the slot takes no room', () => {
    renderPill();
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByTestId('slot')).toBeEmptyDOMElement();
  });

  it("draws this server's live channel", () => {
    live();
    renderPill();
    expect(region()).toHaveAttribute('aria-label', 'Lounge, live voice channel');
    expect(within(region()).getByText('Lounge')).toBeInTheDocument();
  });

  it('names a live channel elsewhere with its server (screens/02)', () => {
    live();
    renderPill('g2');
    expect(region()).toHaveAttribute('aria-label', 'Game Night Lounge, live voice channel');
    expect(region()).toHaveAttribute('data-cross-server', 'true');
  });

  it('is not drawn on the row while a stage is open (the pill became the stage), but stays on the phone', () => {
    live();
    useGlassStore.getState().openStage({ serverId: '__local__', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' });
    const row = renderPill('g1', 'row');
    expect(screen.queryByRole('region')).toBeNull();
    row.unmount();
    renderPill('g1', 'stacked');
    expect(region()).toHaveAttribute('data-layout', 'stacked');
    // Already watching: no Watch button.
    expect(within(region()).queryByRole('button', { name: /^Watch/ })).toBeNull();
  });

  it('forgets an open roster when there is nothing to show', () => {
    useGlassStore.getState().setPillExpanded(true);
    renderPill();
    expect(useGlassStore.getState().pillExpanded).toBe(false);
  });
});

describe('not joined (compact)', () => {
  beforeEach(() => live());

  it('has Listen, Watch, the mute preference and Join, every one named', () => {
    renderPill();
    const pill = within(region());
    expect(pill.getByRole('button', { name: "Show who's in Lounge" })).toHaveAttribute('aria-expanded', 'false');
    expect(pill.getByRole('button', { name: 'Listen in to Lounge' })).toHaveAttribute('aria-pressed', 'false');
    expect(pill.getByRole('button', { name: "Watch Vincent's screen" })).toBeInTheDocument();
    expect(pill.getByRole('button', { name: 'Microphone on when you join' })).toBeInTheDocument();
    expect(pill.getByRole('button', { name: 'Join Lounge' })).toBeInTheDocument();
    // Faces are decoration: nobody is announced twice.
    expect(region().querySelector('.glass-pill__faces')).toHaveAttribute('aria-hidden', 'true');
  });

  it('has one filled button: Join', () => {
    renderPill();
    expect(region().querySelectorAll('.glass-btn--primary')).toHaveLength(1);
    expect(within(region()).getByRole('button', { name: 'Join Lounge' })).toHaveClass('glass-btn--primary');
  });

  it('hides Watch when nobody streams', () => {
    live([BRENDAN, NICK]);
    renderPill();
    expect(within(region()).queryByRole('button', { name: /^Watch/ })).toBeNull();
  });

  it('defaults to joining muted, and the circle shows the preference', () => {
    renderPill();
    const mute = within(region()).getByRole('button', { name: 'Microphone on when you join' });
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    expect(mute).toHaveAttribute('title', "You'll join muted");
    fireEvent.click(mute);
    expect(useJoinMuteStore.getState().joinMuted).toBe(false);
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    expect(mute).toHaveAttribute('title', 'Your microphone will be on when you join');
  });

  it('Watch opens the stage on the streamer, and never joins', () => {
    renderPill();
    fireEvent.click(within(region()).getByRole('button', { name: "Watch Vincent's screen" }));
    expect(useGlassStore.getState().stage).toMatchObject({
      mode: 'side',
      serverId: '__local__',
      guildId: 'g1',
      channelId: 'lounge',
      streamerId: 'vincent',
    });
    expect(actions.joinChannel).not.toHaveBeenCalled();
    expect(actions.listen).not.toHaveBeenCalled();
  });

  it('Join puts the mute preference where the store reads it, then joins', async () => {
    renderPill();
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Join Lounge' }));
    });
    // The store starts unmuted; the default preference is muted.
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().selfMute).toBe(true);
    expect(actions.joinChannel).toHaveBeenCalledWith('lounge', 'g1');
    expect(actions.toggleMute.mock.invocationCallOrder[0]).toBeLessThan(actions.joinChannel.mock.invocationCallOrder[0]);
  });

  it('Join with the microphone on joins unmuted', async () => {
    useJoinMuteStore.setState({ joinMuted: false });
    renderPill();
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Join Lounge' }));
    });
    expect(actions.toggleMute).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().selfMute).toBe(false);
    expect(actions.joinChannel).toHaveBeenCalledWith('lounge', 'g1');
  });

  it('Listen listens in, muted by preference, and never joins', async () => {
    renderPill();
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Listen in to Lounge' }));
    });
    expect(actions.listen).toHaveBeenCalledWith('lounge', 'g1');
    expect(actions.joinChannel).not.toHaveBeenCalled();
  });

  it('says out loud when a join fails', async () => {
    actions.joinChannel.mockImplementationOnce(async () => {
      useVoiceStore.setState({ connectionError: 'The relay is down.', connectionErrorChannelId: 'lounge' });
    });
    renderPill();
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Join Lounge' }));
    });
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Could not join Lounge: The relay is down.',
    ]);
  });
});

describe('listening in', () => {
  beforeEach(() => inCall('listen'));

  it('lights Listen amber and reads "Listening"; pressed again it stops', async () => {
    renderPill();
    const button = within(region()).getByRole('button', { name: 'Stop listening in to Lounge' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveTextContent('Listening');
    expect(button).toHaveAttribute('data-tone', 'amber');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(actions.leaveChannel).toHaveBeenCalledTimes(1);
  });

  it('still offers Join, and from listening it upgrades in place', async () => {
    renderPill();
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Join Lounge' }));
    });
    // The same call: the store's joinChannel is the upgrade (docs/design/glass-g6-checkpoint.md).
    expect(actions.joinChannel).toHaveBeenCalledWith('lounge', 'g1');
    expect(actions.listen).not.toHaveBeenCalled();
  });

  it('the mute circle moves the preference the upgrade will apply', async () => {
    renderPill();
    expect(useVoiceStore.getState().selfMute).toBe(true);
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Microphone on when you join' }));
    });
    expect(useJoinMuteStore.getState().joinMuted).toBe(false);
    expect(useVoiceStore.getState().selfMute).toBe(false);
  });

  it('does not show you among the faces, and says so under the name', () => {
    useGlassStore.getState().setPillExpanded(true);
    renderPill();
    expect(region().querySelectorAll('.glass-pill__faces .glass-face')).toHaveLength(3);
    expect(region().querySelector('.glass-pill__sub')).toHaveTextContent('Listening in quietly');
  });
});

describe('joined', () => {
  beforeEach(() => inCall('joined', { selfMute: false }));

  it('has the microphone, Watch and Leave; no Listen, no mute preference, no Join', () => {
    renderPill();
    const pill = within(region());
    expect(pill.getByRole('button', { name: 'Microphone' })).toHaveAttribute('aria-pressed', 'true');
    expect(pill.getByRole('button', { name: "Watch Vincent's screen" })).toBeInTheDocument();
    expect(pill.getByRole('button', { name: 'Leave Lounge' })).toBeInTheDocument();
    expect(pill.queryByRole('button', { name: /Listen/ })).toBeNull();
    expect(pill.queryByRole('button', { name: /^Join/ })).toBeNull();
    expect(pill.queryByRole('button', { name: 'Microphone on when you join' })).toBeNull();
    // No filled button here: Leave is text.
    expect(region().querySelectorAll('.glass-btn--primary')).toHaveLength(0);
  });

  it('shows you among the faces', () => {
    renderPill();
    expect(region().querySelectorAll('.glass-pill__faces .glass-face')).toHaveLength(4);
  });

  it('the microphone toggles the call mute, and Leave leaves', async () => {
    renderPill();
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Microphone' }));
    });
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(within(region()).getByRole('button', { name: 'Microphone' })).toHaveAttribute('aria-pressed', 'false');
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Leave Lounge' }));
    });
    expect(actions.leaveChannel).toHaveBeenCalledTimes(1);
  });

  it('never writes the join preference from the call microphone', async () => {
    renderPill();
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Microphone' }));
    });
    expect(useJoinMuteStore.getState().joinMuted).toBe(true);
  });

  it('says "You\'re muted" under the name while muted', () => {
    useVoiceStore.setState({ selfMute: true });
    renderPill();
    fireEvent.click(within(region()).getByRole('button', { name: "Show who's in Lounge" }));
    expect(region().querySelector('.glass-pill__sub')).toHaveTextContent("You're muted");
  });
});

describe('a direct message call', () => {
  it('is named for the person, has Leave and no Listen (listening in is for servers)', async () => {
    useChannelStore.setState({
      channelsById: {
        [entityScopeKey(SCOPE, 'dm1')]: {
          id: 'dm1',
          type: 1,
          channel_type: 1,
          name: null,
          recipient: { id: 'mara', username: 'mara', display_name: 'Mara', discriminator: 1, avatar_hash: null },
          key: entityScopeKey(SCOPE, 'dm1'),
          scope: SCOPE,
        },
      },
    } as never);
    useVoiceStore.setState({
      callId: 'call-dm',
      callScope: SCOPE,
      callPhase: 'connected',
      callMode: 'joined',
      connected: true,
      channelId: 'dm1',
      guildId: 'dm',
      selfMute: false,
      channelParticipants: new Map([
        ['dm1', [voiceState('me', { channel_id: 'dm1', guild_id: undefined }), voiceState('mara', { channel_id: 'dm1', guild_id: undefined, username: undefined, display_name: undefined })]],
      ]),
    });
    renderPill(null);
    expect(region()).toHaveAttribute('aria-label', 'Mara, voice call');
    expect(within(region()).getByRole('button', { name: 'Leave Mara' })).toBeInTheDocument();
    expect(within(region()).queryByRole('button', { name: /Listen/ })).toBeNull();
    fireEvent.click(within(region()).getByRole('button', { name: "Show who's in Mara" }));
    expect(within(within(region()).getByRole('list', { name: 'In Mara' })).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      expect.stringContaining('YouMic on'),
      expect.stringContaining('MaraMic on'),
    ]);
  });
});

describe('a call that is still connecting', () => {
  it('shows the buttons busy and does not act twice', async () => {
    live();
    useVoiceStore.setState({
      callId: 'call-1',
      callScope: SCOPE,
      callPhase: 'joining',
      callMode: 'joined',
      joining: true,
      channelId: 'lounge',
      guildId: 'g1',
    });
    renderPill();
    const join = within(region()).getByRole('button', { name: 'Join Lounge' });
    expect(join).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(join);
    expect(actions.joinChannel).not.toHaveBeenCalled();
  });
});

describe('listening in turned off for a channel', () => {
  it('disables Listen with the server\'s sentence as its tooltip, and toasts it once', async () => {
    live();
    const sentence = 'Listening in is turned off in Lounge.';
    actions.listen.mockImplementationOnce(async () => {
      useVoiceStore.setState({
        connectionError: sentence,
        connectionErrorChannelId: 'lounge',
        connectionErrorCode: 'LISTEN_IN_DISABLED',
      });
    });
    renderPill();
    await act(async () => {
      fireEvent.click(within(region()).getByRole('button', { name: 'Listen in to Lounge' }));
    });
    const listen = within(region()).getByRole('button', { name: 'Listen in to Lounge' });
    expect(listen).toHaveAttribute('aria-disabled', 'true');
    expect(listen).toHaveAttribute('title', sentence);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([sentence]);
    // Pressing it again asks nothing of the server, and never turns into a join.
    await act(async () => {
      fireEvent.click(listen);
    });
    expect(actions.listen).toHaveBeenCalledTimes(1);
    expect(actions.joinChannel).not.toHaveBeenCalled();
    // Join is still there: joining is a different thing, and only the person chooses it.
    expect(within(region()).getByRole('button', { name: 'Join Lounge' })).not.toHaveAttribute('aria-disabled');
  });
});

describe('expanded', () => {
  it('grows on a click of the faces or name, and shows the roster with each state', () => {
    live();
    renderPill();
    const who = within(region()).getByRole('button', { name: "Show who's in Lounge" });
    fireEvent.click(who);
    expect(useGlassStore.getState().pillExpanded).toBe(true);
    expect(region()).toHaveAttribute('data-phase', 'expanded');
    expect(who).toHaveAttribute('aria-expanded', 'true');
    const roster = within(region()).getByRole('list', { name: 'In Lounge' });
    const rows = within(roster).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('VincentSharing screen'),
      expect.stringContaining('BrendanMic on'),
      expect.stringContaining('NickMuted'),
    ]);
    // Amber means live: only sharing and talking wear the ring.
    expect(rows.map((row) => row.getAttribute('data-lit'))).toEqual(['true', 'false', 'false']);
    expect(who).toHaveAttribute('aria-controls', region().querySelector('.glass-pill__body')?.id);
  });

  it("names people as the server's roster does, not by their username", () => {
    useMemberStore.setState({
      members: new Map([
        [
          entityScopeKey(SCOPE, 'g1'),
          [{ user: { id: 'brendan', username: 'brendan', display_name: 'Brendan Q', avatar_hash: null }, nick: null, roles: [], joined_at: '', deaf: false, mute: false }],
        ],
      ]),
    } as never);
    live([VINCENT, voiceState('brendan', { display_name: null })]);
    useGlassStore.getState().setPillExpanded(true);
    renderPill();
    const rows = within(within(region()).getByRole('list', { name: 'In Lounge' })).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.glass-pill__person-name')?.textContent)).toEqual(['Vincent', 'Brendan Q']);
  });

  it('marks who talks, and says "Listening in" for listeners, with the sentence while you listen', () => {
    inCall('listen', { speakingUsers: new Set(['brendan']) });
    useGlassStore.getState().setPillExpanded(true);
    renderPill();
    const rows = within(within(region()).getByRole('list', { name: 'In Lounge' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Sharing screen'),
      expect.stringContaining('Talking'),
      expect.stringContaining('Muted'),
      expect.stringContaining('YouListening in'),
    ]);
    expect(within(region()).getByText("Everyone in Lounge can see you're listening in.")).toBeInTheDocument();
    expect(region()).toHaveAttribute('data-note', 'true');
  });

  it('does not show the sentence when you are not listening', () => {
    inCall('joined', { selfMute: false });
    useGlassStore.getState().setPillExpanded(true);
    renderPill();
    expect(screen.queryByText(/can see you're listening in/)).toBeNull();
    expect(within(region()).getByText('Mic on', { selector: '[data-tone="ink"]' })).toBeInTheDocument();
  });

  it('Escape collapses it and the focus returns to what opened it', () => {
    live();
    vi.useFakeTimers();
    try {
      renderPill();
      const who = within(region()).getByRole('button', { name: "Show who's in Lounge" });
      fireEvent.click(who);
      const inBody = region().querySelector<HTMLElement>('.glass-pill__preview');
      inBody?.focus();
      expect(inBody).toHaveFocus();
      fireEvent.keyDown(inBody as HTMLElement, { key: 'Escape' });
      expect(useGlassStore.getState().pillExpanded).toBe(false);
      expect(who).toHaveFocus();
      // The words fade first, then the capsule shrinks.
      expect(region()).toHaveAttribute('data-phase', 'closing');
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(region()).toHaveAttribute('data-phase', 'compact');
      expect(region().querySelector('.glass-pill__body')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second click on the faces collapses it too', () => {
    live();
    renderPill();
    const who = within(region()).getByRole('button', { name: "Show who's in Lounge" });
    fireEvent.click(who);
    fireEvent.click(who);
    expect(useGlassStore.getState().pillExpanded).toBe(false);
  });

  it('the preview is a button that watches, and it is named', () => {
    live();
    useGlassStore.getState().setPillExpanded(true);
    renderPill();
    const preview = region().querySelector('.glass-pill__preview') as HTMLElement;
    expect(preview).toHaveAccessibleName("Watch Vincent's screen");
    expect(within(preview).getByText("Vincent's screen")).toBeInTheDocument();
    fireEvent.click(preview);
    expect(useGlassStore.getState().stage.streamerId).toBe('vincent');
    // The stage grows out of the pill: the pill is compact again under it.
    expect(useGlassStore.getState().pillExpanded).toBe(false);
  });

  it('has no preview when nobody streams', () => {
    live([BRENDAN, NICK]);
    useGlassStore.getState().setPillExpanded(true);
    renderPill();
    expect(region().querySelector('.glass-pill__preview')).toBeNull();
    expect(within(region()).getByRole('list', { name: 'In Lounge' })).toBeInTheDocument();
  });
});

describe('the preview feed', () => {
  const view = (kind: 'ambient' | 'watch', over: Record<string, unknown> = {}) => ({
    id: `${kind}-1`,
    kind,
    scope: SCOPE,
    guildId: 'g1',
    channelId: 'lounge',
    streamerId: 'vincent',
    route: 'session',
    phase: 'live',
    engine: {},
    sessionId: 's',
    endReason: null,
    pauseReason: null,
    error: null,
    ...over,
  });

  beforeEach(() => {
    live();
    useGlassStore.getState().setPillExpanded(true);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
  });

  it('draws the ambient view of this stream', () => {
    useVoiceStore.setState({ ambientView: view('ambient') as never });
    renderPill();
    expect(frames.subscribe).toHaveBeenCalledWith('ambient', expect.any(Function), { fps: 4 });
  });

  it('prefers the watch of this stream over the ambient one', () => {
    useVoiceStore.setState({ ambientView: view('ambient') as never, watchView: view('watch') as never });
    renderPill();
    expect(frames.subscribe).toHaveBeenCalledWith('watch', expect.any(Function), { fps: 4 });
  });

  it("never draws another stream's view, or one that is not live, and opens none of its own", () => {
    useVoiceStore.setState({
      ambientView: view('ambient', { streamerId: 'somebody-else' }) as never,
      watchView: view('watch', { phase: 'connecting' }) as never,
    });
    renderPill();
    expect(frames.subscribe).not.toHaveBeenCalled();
    expect(region().querySelector('.glass-pill__preview')).toBeInTheDocument();
  });

  it('stops sampling when the pill collapses', () => {
    const stop = vi.fn();
    frames.subscribe.mockReturnValue(stop);
    useVoiceStore.setState({ ambientView: view('ambient') as never });
    const { unmount } = renderPill();
    expect(stop).not.toHaveBeenCalled();
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('the talking waveform', () => {
  it('follows the real voice inside a call, marked for the level engine', () => {
    inCall('joined', { selfMute: false, speakingUsers: new Set(['brendan']) });
    renderPill();
    const wave = region().querySelector('.glass-pill__wave') as HTMLElement;
    expect(wave).toHaveAttribute('data-real');
    expect(wave).toHaveAttribute('data-motion-speaking', 'brendan');
    expect(wave).toHaveAttribute('aria-hidden', 'true');
  });

  it('loops for a channel you are not in, when the server says somebody talks', () => {
    live();
    useRemoteSpeakingStore.setState({ byChannel: new Map([['g1:lounge', new Set(['brendan'])]]) });
    renderPill();
    const wave = region().querySelector('.glass-pill__wave') as HTMLElement;
    expect(wave).toBeInTheDocument();
    expect(wave).not.toHaveAttribute('data-real');
  });

  it('keeps its place but draws nothing while nobody talks', () => {
    live();
    renderPill();
    expect(region().querySelector('.glass-pill__wave-slot')).toBeInTheDocument();
    expect(region().querySelector('.glass-pill__wave')).toBeNull();
  });
});

describe('giving up space (§5)', () => {
  const widths = { 0: 452, 1: 452, 2: 380, 3: 124 } as Record<string, number>;
  let restore: Array<() => void> = [];

  const stub = (slotWidth: number) => {
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('glass-pill') ? widths[this.dataset.collapse ?? '0'] : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('glass-header__pill') ? slotWidth : 0;
      },
    });
    restore.push(() => {
      if (offset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
      if (client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    });
  };

  afterEach(() => {
    for (const fn of restore) fn();
    restore = [];
  });

  beforeEach(() => live());

  it('draws everything when the slot is wide enough', () => {
    stub(600);
    renderPill();
    expect(region()).toHaveAttribute('data-collapse', '0');
  });

  it('drops the Watch and Listen labels, keeping their icons and names', () => {
    stub(400);
    renderPill();
    expect(region()).toHaveAttribute('data-collapse', '2');
    // CSS hides the label; the buttons keep their accessible names.
    expect(within(region()).getByRole('button', { name: 'Listen in to Lounge' })).toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: "Watch Vincent's screen" })).toBeInTheDocument();
  });

  it('keeps only the faces and Join when it is shorter still', () => {
    stub(200);
    renderPill();
    expect(region()).toHaveAttribute('data-collapse', '3');
    expect(within(region()).getByRole('button', { name: 'Join Lounge' })).toBeInTheDocument();
  });
});

describe('the phone (§8)', () => {
  beforeEach(() => live());

  it('is two rows: who is here and who talks, then Listen, the mute circle and Join', () => {
    useRemoteSpeakingStore.setState({ byChannel: new Map([['g1:lounge', new Set(['brendan'])]]) });
    renderPill('g1', 'stacked');
    const pill = region();
    expect(pill).toHaveAttribute('data-layout', 'stacked');
    const top = pill.querySelector('.glass-pill__top') as HTMLElement;
    expect(within(top).getByText('Lounge')).toBeInTheDocument();
    expect(within(top).getByText('Brendan is talking')).toBeInTheDocument();
    const actionsRow = pill.querySelector('.glass-pill__actions') as HTMLElement;
    expect(within(actionsRow).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Listen in to Lounge',
      "Watch Vincent's screen",
      'Microphone on when you join',
      'Join Lounge',
    ]);
  });

  it('does not collapse (the phone has the room)', () => {
    renderPill('g1', 'stacked');
    expect(region()).not.toHaveAttribute('data-collapse');
  });

  it('opens the roster in place', () => {
    renderPill('g1', 'stacked');
    fireEvent.click(within(region()).getByRole('button', { name: "Show who's in Lounge" }));
    expect(within(region()).getByRole('list', { name: 'In Lounge' })).toBeInTheDocument();
  });
});

describe('saying what happened', () => {
  it('announces joining and leaving to a screen reader', () => {
    live();
    renderPill();
    const status = region().querySelector('[role="status"]') as HTMLElement;
    expect(status).toHaveTextContent('');
    act(() => {
      inCall('listen');
    });
    expect(status).toHaveTextContent('Listening in to Lounge');
    act(() => {
      inCall('joined', { selfMute: false });
    });
    expect(status).toHaveTextContent('Joined Lounge');
  });
});
