import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
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

/**
 * The stage in theater (docs/glass-spec.md §6.2, §6.3, §9; WP-G15). The pictures
 * are the Playwright shots (e2e/glass-theater.spec.ts, held against screens/05
 * and 06); this suite holds what switching layouts must never do (remount the
 * stream, stop the watch), the theater's own controls, and the keys.
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

function StageFromStore({ target }: { target: StageTarget }) {
  const mode = useGlassStore((state) => state.stage.mode);
  return (
    <section className="glass-frame__stage">
      <Stage target={target} mode={mode === 'theater' ? 'theater' : 'side'} />
    </section>
  );
}

function renderStage(target: StageTarget = LOUNGE, mode: 'side' | 'theater' = 'side') {
  act(() => useGlassStore.getState().openStage(target, mode));
  return render(
    <MemoryRouter initialEntries={['/app/guilds/g1/channels/general']}>
      <Routes>
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<StageFromStore target={target} />} />
      </Routes>
    </MemoryRouter>,
  );
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

describe('theater', () => {
  it('switching layouts keeps the stream: same canvas, one subscription, the watch never stopped', () => {
    const engine = fakeEngine();
    useVoiceStore.setState({ watchView: watchView('live', { engine }) });
    renderStage();
    const canvas = document.querySelector('.glass-stage__canvas');
    expect(engine.subscribeVideo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 't' });
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    expect(document.querySelector('.glass-stage')).toHaveAttribute('data-mode', 'theater');
    expect(document.querySelector('.glass-stage__canvas')).toBe(canvas);
    expect(engine.subscribeVideo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 't' });
    expect(document.querySelector('.glass-stage')).toHaveAttribute('data-mode', 'side');
    expect(document.querySelector('.glass-stage__canvas')).toBe(canvas);
    expect(engine.subscribeVideo).toHaveBeenCalledTimes(1);
    expect(actions.stopWatch).not.toHaveBeenCalled();
  });

  it('draws the talker as the one tile and the rest as faces, and the controls stay the same set', () => {
    joined();
    useVoiceStore.setState({ speakingUsers: new Set(['brendan']) });
    renderStage(LOUNGE, 'theater');
    const people = screen.getByRole('list', { name: 'People in the call' });
    expect(people).toHaveAttribute('data-glass-move', 'people-theater');
    expect(within(people).getAllByRole('listitem')).toHaveLength(4);
    expect(document.querySelectorAll('.glass-theater__people .glass-stage__tile')).toHaveLength(1);
    expect(document.querySelector('.glass-theater__people .glass-stage__tile')).toHaveTextContent('Brendan');
    expect(screen.getByRole('group', { name: 'Call controls' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave Lounge' })).toBeInTheDocument();
  });

  it('the chat button (H) hides and shows the chat; it says which it will do', () => {
    renderStage(LOUNGE, 'theater');
    const show = screen.getByRole('button', { name: 'Show chat' });
    expect(show).toHaveAttribute('aria-pressed', 'false');
    expect(show).toHaveAttribute('aria-keyshortcuts', 'H');
    expect(document.querySelector('.glass-stage')).toHaveAttribute('data-chat', 'hidden');
    fireEvent.click(show);
    expect(useGlassStore.getState().chatHidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide chat' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'h' });
    expect(useGlassStore.getState().chatHidden).toBe(true);
  });

  it('while browsing in theater the chat is out of the way, and the chat button brings it back', () => {
    renderStage(LOUNGE, 'theater');
    act(() => useGlassStore.getState().setBrowseOpen(true));
    expect(document.querySelector('.glass-stage')).toHaveAttribute('data-browse', 'true');
    expect(document.querySelector('.glass-stage')).toHaveAttribute('data-chat', 'hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Show chat' }));
    expect(useGlassStore.getState().browseOpen).toBe(false);
    expect(useGlassStore.getState().chatHidden).toBe(false);
  });

  it('T and the layout button name where they go, side by side has no chat button', () => {
    renderStage();
    expect(screen.queryByRole('button', { name: /chat/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Theater mode' }));
    expect(screen.getByRole('button', { name: 'Show side by side with chat' })).toHaveAttribute('aria-keyshortcuts', 'T');
  });
});
