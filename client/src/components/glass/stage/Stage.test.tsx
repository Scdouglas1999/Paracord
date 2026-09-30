import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore, type StageTarget } from '../../../stores/glassStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useToastStore } from '../../../stores/toastStore';
import type { MediaViewState } from '../../../stores/voice/viewSessions';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { VoiceState } from '../../../types';
import { useJoinMuteStore } from '../pill/muteStore';
import { Stage } from './Stage';
import { underlayHoleCount } from './nativeUnderlay';

/**
 * The stage, side by side (docs/glass-spec.md §6.1). What it draws is held by
 * the screenshots (docs/design/glass-g14-checkpoint.md); this suite holds the
 * watch's lifecycle (start on open, switch, stop on close, never on a timer,
 * never leaving the call), what each control calls, and that every control is
 * named.
 */

const SCOPE = { serverId: '__local__', userId: 'me' };
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => SCOPE,
  useCurrentUser: () => ({ id: 'me', username: 'sean', display_name: 'Sean', avatar_hash: null }),
}));
vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:face') },
}));
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: true, isOwner: false, isLoading: false }),
}));
vi.mock('../../voice/together/useTogether', () => ({ useTogether: () => null }));
vi.mock('../shell/useGlassLayout', () => ({ useGlassLayout: () => 'wide' }));
const glow = vi.hoisted(() => ({ subscribe: vi.fn(() => () => {}) }));
vi.mock('../../../lib/room/viewFrameSource', () => ({
  createViewFrameSource: () => ({ kind: 'stream', width: 0, height: 0, route: null, subscribe: glow.subscribe, getLatestFrame: async () => null }),
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

const STARTED = new Date(Date.now() - 42 * 60_000 - 5_000).toISOString();
const VINCENT = voiceState('vincent', { self_stream: true, self_stream_started_at: STARTED });
const BRENDAN = voiceState('brendan', { self_video: true });
const NICK = voiceState('nick', { self_mute: true });
const LUKE = voiceState('luke', { self_stream: true, self_stream_started_at: STARTED });

const LOUNGE: StageTarget = { serverId: '__local__', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

const original = {
  startWatch: useVoiceStore.getState().startWatch,
  stopWatch: useVoiceStore.getState().stopWatch,
  fetchWatchers: useVoiceStore.getState().fetchWatchers,
  joinChannel: useVoiceStore.getState().joinChannel,
  leaveChannel: useVoiceStore.getState().leaveChannel,
  toggleMute: useVoiceStore.getState().toggleMute,
  toggleVideo: useVoiceStore.getState().toggleVideo,
};

const actions = {
  startWatch: vi.fn(async () => {}),
  stopWatch: vi.fn(async () => {}),
  fetchWatchers: vi.fn(async () => {}),
  joinChannel: vi.fn(async () => {}),
  leaveChannel: vi.fn(async () => {}),
  toggleMute: vi.fn(async () => {
    useVoiceStore.setState((state) => ({ selfMute: !state.selfMute }));
  }),
  toggleVideo: vi.fn(async () => {}),
};

function fakeEngine(): MediaEngine & { subscribeVideo: ReturnType<typeof vi.fn> } {
  return { subscribeVideo: vi.fn(() => () => {}) } as unknown as MediaEngine & { subscribeVideo: ReturnType<typeof vi.fn> };
}

function watchView(phase: MediaViewState['phase'], over: Partial<MediaViewState> = {}): MediaViewState {
  return {
    id: 'w1',
    kind: 'watch',
    scope: SCOPE,
    guildId: 'g1',
    channelId: 'lounge',
    streamerId: 'vincent',
    route: 'session',
    phase,
    engine: null,
    sessionId: 'view-1',
    endReason: null,
    pauseReason: null,
    error: null,
    ...over,
  } as MediaViewState;
}

function renderStage(target: StageTarget = LOUNGE, options: { strict?: boolean } = {}) {
  act(() => useGlassStore.getState().openStage(target));
  const tree = (
    <section className="glass-frame__stage">
      <Stage target={target} mode="side" />
    </section>
  );
  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

function joined() {
  useVoiceStore.setState({
    callId: 'call-1',
    callScope: SCOPE,
    callPhase: 'connected',
    callMode: 'joined',
    connected: true,
    channelId: 'lounge',
    guildId: 'g1',
    selfMute: false,
    channelParticipants: new Map([['lounge', [VINCENT, BRENDAN, NICK, voiceState('me')]]]),
  });
}

beforeEach(() => {
  vi.useRealTimers();
  for (const fn of Object.values(actions)) fn.mockClear();
  glow.subscribe.mockClear();
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
    mediaEngine: null,
    watchView: null,
    watchers: new Map(),
    speakingUsers: new Set(),
    channelParticipants: new Map([['lounge', [VINCENT, BRENDAN, NICK]]]),
  });
  useGlassStore.getState().reset();
  useJoinMuteStore.setState({ joinMuted: true });
  useToastStore.setState({ toasts: [] });
  useChannelStore.setState({
    channelsById: {
      [entityScopeKey(SCOPE, 'lounge')]: { id: 'lounge', name: 'Lounge', guild_id: 'g1', type: 2, position: 0 },
    } as never,
  });
  useGuildStore.setState({
    guilds: [{ key: entityScopeKey(SCOPE, 'g1'), id: 'g1', name: 'Game Night', scope: SCOPE, originServerId: '__local__' }] as never,
  });
});

afterEach(() => {
  useVoiceStore.setState({ ...original, watchView: null, channelParticipants: new Map(), callId: null, connected: false });
  useGlassStore.getState().reset();
});

describe('the watch', () => {
  it('starts watching the stream when the stage opens, and loads the watcher count', () => {
    renderStage();
    expect(actions.startWatch).toHaveBeenCalledTimes(1);
    expect(actions.startWatch).toHaveBeenCalledWith(LOUNGE);
    expect(actions.fetchWatchers).toHaveBeenCalledWith({ serverId: '__local__', channelId: 'lounge' });
    expect(actions.joinChannel).not.toHaveBeenCalled();
  });

  it("names the stream and its place: Vincent's screen, Game Night Lounge, live for 42 min", () => {
    renderStage();
    expect(screen.getByText("Vincent's screen")).toBeInTheDocument();
    expect(screen.getByText(/Game Night Lounge, live for 42 min/)).toBeInTheDocument();
  });

  it('shows the watcher count the server keeps', () => {
    useVoiceStore.setState({ watchers: new Map([[entityScopeKey(SCOPE, 'lounge'), new Map([['vincent', 2]])]]) });
    renderStage();
    expect(screen.getByText('2 watching')).toBeInTheDocument();
  });

  it('Stop watching closes the stage and stops the watch, and never leaves the call', () => {
    joined();
    renderStage();
    fireEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
    expect(useGlassStore.getState().stage.mode).toBe('none');
    expect(actions.stopWatch).toHaveBeenCalled();
    expect(actions.leaveChannel).not.toHaveBeenCalled();
  });

  it('keeps the watch through a remount that keeps the stage open (StrictMode), and stops it once closed', () => {
    const { unmount } = renderStage(LOUNGE, { strict: true });
    expect(actions.stopWatch).not.toHaveBeenCalled();
    act(() => useGlassStore.getState().closeStage());
    unmount();
    expect(actions.stopWatch).toHaveBeenCalledTimes(1);
  });

  it('never clears a connecting watch on a timer (glass-fix-rejoin Bug 2 cause 2)', () => {
    vi.useFakeTimers();
    useVoiceStore.setState({ watchView: watchView('connecting') });
    renderStage();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(actions.stopWatch).not.toHaveBeenCalled();
    expect(actions.startWatch).toHaveBeenCalledTimes(1);
    expect(useGlassStore.getState().stage.mode).toBe('side');
    expect(screen.getByText("Connecting to Vincent's screen…")).toBeInTheDocument();
  });

  it('draws the watch through its engine, and subscribes again when the watch moves to the call', () => {
    const session = fakeEngine();
    useVoiceStore.setState({ watchView: watchView('live', { engine: session }) });
    renderStage();
    expect(session.subscribeVideo).toHaveBeenCalledTimes(1);
    const [userId, canvas, , options] = session.subscribeVideo.mock.calls[0];
    expect(userId).toBe('vincent');
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(options).toEqual({ preferredTrackId: 'screen' });

    const call = fakeEngine();
    act(() => useVoiceStore.setState({ watchView: watchView('live', { engine: call, route: 'call' }) }));
    expect(call.subscribeVideo).toHaveBeenCalledTimes(1);
    expect(session.subscribeVideo).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed watch down with its reason, and Watch again asks once more', () => {
    useVoiceStore.setState({ watchView: watchView('failed', { error: 'The relay refused the view.', endReason: 'failed' }) });
    renderStage();
    expect(screen.getByText('The relay refused the view.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch again' }));
    expect(actions.startWatch).toHaveBeenCalledTimes(2);
  });

  it("switches the watch with a click on another sharer's chip, without stopping in between", () => {
    useVoiceStore.setState({ channelParticipants: new Map([['lounge', [VINCENT, BRENDAN, NICK, LUKE]]]) });
    const { rerender } = renderStage();
    fireEvent.click(screen.getByRole('button', { name: "Watch Luke's screen" }));
    const stage = useGlassStore.getState().stage;
    expect(stage.streamerId).toBe('luke');
    rerender(
      <section className="glass-frame__stage">
        <Stage target={{ ...LOUNGE, streamerId: 'luke' }} mode="side" />
      </section>,
    );
    expect(actions.startWatch).toHaveBeenLastCalledWith({ ...LOUNGE, streamerId: 'luke' });
    expect(actions.stopWatch).not.toHaveBeenCalled();
  });
});

describe('keyboard', () => {
  it('Esc stops watching', () => {
    renderStage();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useGlassStore.getState().stage.mode).toBe('none');
  });

  it('Esc while typing is the message box’s, not the stage’s', () => {
    renderStage();
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(useGlassStore.getState().stage.mode).toBe('side');
    box.remove();
  });

  it('Esc while browsing puts the places panel away first', () => {
    renderStage();
    act(() => useGlassStore.getState().setBrowseOpen(true));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useGlassStore.getState().browseOpen).toBe(false);
    expect(useGlassStore.getState().stage.mode).toBe('side');
  });

  it('S opens browse from the sidebar button, T switches to theater', () => {
    renderStage();
    fireEvent.click(screen.getByRole('button', { name: 'Show servers and channels' }));
    expect(useGlassStore.getState().browseOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Theater mode' }));
    expect(useGlassStore.getState().stage.mode).toBe('theater');
  });
});

describe('people', () => {
  it('gives Brendan a camera tile (talking, amber edge) and the others chips', () => {
    useVoiceStore.setState({ speakingUsers: new Set(['brendan']) });
    joined();
    useVoiceStore.setState({ speakingUsers: new Set(['brendan']) });
    const { container } = renderStage();
    const tiles = container.querySelectorAll('.glass-stage__tile');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toHaveTextContent('Brendan');
    expect(tiles[0]).toHaveAttribute('data-talking', 'true');
    const chips = [...container.querySelectorAll('.glass-stage__chip')].map((chip) => chip.textContent);
    expect(chips).toEqual([
      expect.stringContaining('VincentSharing screen'),
      expect.stringContaining('NickMuted'),
      expect.stringContaining('YouMic on'),
    ]);
  });

  it('draws a camera from the call once joined, and only then', () => {
    const call = fakeEngine();
    useVoiceStore.setState({ mediaEngine: call });
    const { unmount } = renderStage();
    expect(call.subscribeVideo).not.toHaveBeenCalled();
    unmount();
    joined();
    renderStage();
    expect(call.subscribeVideo).toHaveBeenCalledWith('brendan', expect.any(HTMLCanvasElement), expect.any(Function), {
      preferredTrackId: 'camera',
    });
  });

  it('opens and closes a native underlay hole with the surface under the stream', () => {
    const session = fakeEngine();
    useVoiceStore.setState({ watchView: watchView('live', { engine: session }) });
    const { container } = renderStage();
    const canvas = container.querySelector('.glass-stage__canvas') as HTMLCanvasElement;
    act(() => {
      canvas.dispatchEvent(new CustomEvent('paracord:native-surface-visibility', { bubbles: true, detail: { visible: true } }));
    });
    expect(document.documentElement).toHaveAttribute('data-native-underlay');
    expect(container.querySelector('.glass-stage__stream')).toHaveAttribute('data-underlay', 'live');
    act(() => {
      canvas.dispatchEvent(new CustomEvent('paracord:native-surface-visibility', { bubbles: true, detail: { visible: false } }));
    });
    expect(document.documentElement).not.toHaveAttribute('data-native-underlay');
    expect(underlayHoleCount()).toBe(0);
  });
});

describe('controls', () => {
  it('not joined: flame, heart, Clip, the mute preference and Join (the one filled button)', () => {
    renderStage();
    const row = screen.getByRole('group', { name: 'Call controls' });
    const names = within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['React with fire', 'React with a heart', 'Clip', 'Microphone on when you join', 'Join Lounge']);
    expect(row.querySelectorAll('.glass-btn--primary')).toHaveLength(1);
  });

  it('Join joins with the mute preference; watching never joined by itself', async () => {
    renderStage();
    expect(actions.joinChannel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Join Lounge' }));
    await vi.waitFor(() => expect(actions.joinChannel).toHaveBeenCalledWith('lounge', 'g1'));
    // The preference (muted) went in first.
    expect(useVoiceStore.getState().selfMute).toBe(true);
  });

  it('the mute preference flips what the next join applies', () => {
    renderStage();
    const pref = screen.getByRole('button', { name: 'Microphone on when you join' });
    expect(pref).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pref);
    expect(useJoinMuteStore.getState().joinMuted).toBe(false);
  });

  it('joined: mic, camera, share, flame, heart, Clip, More and Leave; no Join', () => {
    joined();
    renderStage();
    const row = screen.getByRole('group', { name: 'Call controls' });
    const names = within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual([
      'Microphone',
      'Camera',
      'Share your screen',
      'React with fire',
      'React with a heart',
      'Clip',
      'More call actions',
      'Leave Lounge',
    ]);
    expect(row.querySelectorAll('.glass-btn--primary')).toHaveLength(0);
  });

  it('Leave is the only way out of the call', () => {
    joined();
    renderStage();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Lounge' }));
    expect(actions.leaveChannel).toHaveBeenCalledTimes(1);
  });

  it('the microphone toggles, and its menu (right-click) holds Deafen', () => {
    joined();
    renderStage();
    const mic = screen.getByRole('button', { name: 'Microphone' });
    expect(mic).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(mic);
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(mic);
    expect(screen.getByRole('dialog', { name: 'Microphone and speaker' })).toBeInTheDocument();
    const deafen = screen.getByRole('button', { name: /^Deafen/ });
    expect(deafen).toHaveAttribute('aria-pressed', 'false');
  });

  it('More holds soundboard, invite, devices and the connection check', () => {
    joined();
    renderStage();
    fireEvent.click(screen.getByRole('button', { name: 'More call actions' }));
    const menu = screen.getByRole('menu', { name: 'More call actions' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Soundboard',
      'Invite people',
      'Microphone and speaker',
      'Connection check',
    ]);
  });

  it('flame, heart and Clip say they are not available yet instead of pretending', () => {
    renderStage();
    const clip = screen.getByRole('button', { name: 'Clip' });
    expect(clip).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'React with fire' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(clip);
    // WP-G16: no watch is live here, so Clip waits for the stream and says so.
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe("Waiting for Vincent's screen.");
  });
});

describe('the glow', () => {
  it('samples the watched stream once a second', () => {
    renderStage();
    expect(glow.subscribe).toHaveBeenCalledWith(expect.any(Function), 1);
  });
});
