import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { GuildHomePage } from './GuildHomePage';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { scopeGuild, useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import { useTypingStore } from '../stores/typingStore';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { roomLitHistory } from '../lib/attention/light';
import { LOCAL_SERVER_ID, entityScopeKey } from '../lib/serverScope';
import { ChannelType, Permissions, type Channel, type Member, type VoiceState } from '../types';

/**
 * The Lobby, end to end (docs/lantern-stage-spec.md §7.3).
 *
 * The light is derived from the **real** stores — seeded exactly the way WP1's
 * `useLights.test.tsx` seeds them — so these assertions exercise the same
 * derivation the running app uses. Only the three things that reach the network
 * or the media engine are mocked: permissions, unread counts, and the calendar.
 */

const SERVER = LOCAL_SERVER_ID;
const SCOPE = { serverId: SERVER, userId: 'viewer' };
const GUILD = 'g1';

const api = vi.hoisted(() => ({
  events: [] as unknown[],
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
const gates = vi.hoisted(() => ({
  permissions: 0n,
  isAdmin: false,
  unread: new Set<string>(),
  mentions: new Map<string, number>(),
  joinChannel: vi.fn(),
}));

vi.mock('../api/activeClient', () => ({
  getApi: () => ({
    get: api.get,
    put: api.put,
    delete: api.delete,
  }),
}));

vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: gates.permissions,
    isAdmin: gates.isAdmin,
    isOwner: false,
    isLoading: false,
    guildLevelOnly: true,
  }),
}));

vi.mock('../hooks/useUnreadCounts', () => ({
  useUnreadCounts: () => ({
    isChannelUnread: gates.unread,
    channelMentionCounts: gates.mentions,
  }),
}));

vi.mock('../hooks/useMutedGuilds', () => ({
  useMutedGuilds: () => ({ mutedGuildKeys: [] as string[], saving: false }),
}));

vi.mock('../hooks/useVoice', () => ({
  useVoice: () => ({ joinChannel: gates.joinChannel }),
}));

// InviteModal reaches into the API and the clipboard on mount.
vi.mock('../components/guild/InviteModal', () => ({
  InviteModal: () => <div data-testid="invite-modal" />,
}));

vi.mock('../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:lobby-test') },
}));

// ---- fixtures --------------------------------------------------------------

function chan(over: Partial<Channel> & { id: string; type: ChannelType }): Channel {
  return { position: 0, nsfw: false, created_at: '', guild_id: GUILD, ...over } as Channel;
}

function member(id: string, username: string): Member {
  return {
    user: { id, username, discriminator: 0, bot: false, system: false, flags: 0, created_at: '' },
    roles: [],
    joined_at: '',
    deaf: false,
    mute: false,
  } as unknown as Member;
}

function voiceState(over: Partial<VoiceState> & { user_id: string }): VoiceState {
  return {
    session_id: 's',
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    guild_id: GUILD,
    ...over,
  };
}

function seed(): void {
  useAuthStore.setState({ user: { id: 'viewer', username: 'viewer' } as never, token: 'token' });
  useServerListStore.setState({ servers: [], activeServerId: null });
  useGuildStore.setState({
    guilds: [
      scopeGuild(
        { id: GUILD, name: 'Kestrel Robotics', owner_id: 'owner', member_count: 61, created_at: '' },
        SCOPE,
      ),
    ],
  });
  useChannelStore.getState().setChannels(
    GUILD,
    [
      chan({ id: 'v1', type: ChannelType.Voice, name: 'Shop floor', position: 0 }),
      chan({ id: 'v2', type: ChannelType.Voice, name: 'Lounge', position: 1 }),
      chan({ id: 't1', type: ChannelType.Text, name: 'build-log', position: 2 }),
      chan({ id: 't2', type: ChannelType.Text, name: 'firmware', position: 3 }),
    ],
    SCOPE,
  );
  useMemberStore.setState({
    members: new Map([
      [
        entityScopeKey(SCOPE, GUILD),
        [member('1', 'mara'), member('2', 'priya'), member('3', 'ren')],
      ],
    ]),
  });
  usePresenceStore.getState().setPresences(
    [
      { user_id: '1', status: 'online', activities: [] },
      { user_id: '2', status: 'online', activities: [] },
      { user_id: '3', status: 'offline', activities: [] },
    ],
    SERVER,
  );
  useVoiceStore.setState({
    channelParticipants: new Map<string, VoiceState[]>(),
    speakingUsers: new Set<string>(),
    channelId: null,
    guildId: null,
    connected: false,
    mediaEngine: null,
  });
  useTypingStore.setState({ typingByChannel: {} });
}

function light(channelId: string, states: VoiceState[]): void {
  act(() => {
    useVoiceStore.setState({ channelParticipants: new Map([[channelId, states]]) });
  });
}

function LocationProbe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

function renderLobby() {
  return render(
    <MemoryRouter initialEntries={[`/app/guilds/${GUILD}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/app/guilds/:guildId" element={<GuildHomePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.events = [];
  api.get.mockImplementation(async () => ({ data: api.events }));
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  gates.permissions = 0n;
  gates.isAdmin = false;
  gates.unread = new Set();
  gates.mentions = new Map();
  gates.joinChannel = vi.fn();
  roomLitHistory.clear();
  useGuildStore.getState().reset();
  useChannelStore.getState().reset();
  useMemberStore.getState().reset();
  usePresenceStore.getState().reset();
  useTypingStore.getState().reset();
  useUIStore.setState({ guildSettingsId: null, guildSettingsInitialSection: null });
  seed();
});

afterEach(() => {
  cleanup();
  roomLitHistory.clear();
});

// ---- the header ------------------------------------------------------------

describe('the Lobby header', () => {
  it('names the building and counts its lights in one line', async () => {
    light('v1', [voiceState({ user_id: '1' })]);
    renderLobby();

    expect(screen.getByRole('heading', { name: 'Kestrel Robotics' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText('2 of 61 have their lights on · 1 room lit'),
      ).toBeInTheDocument(),
    );
  });

  it('hides building settings without the permission, and opens them with it', () => {
    const { unmount } = renderLobby();
    expect(screen.queryByRole('button', { name: 'Building settings' })).not.toBeInTheDocument();
    unmount();

    gates.isAdmin = true;
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Building settings' }));
    expect(useUIStore.getState().guildSettingsId).toBe(GUILD);
  });

  it('offers invite when there is a room to invite somebody into', () => {
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }));
    expect(screen.getByTestId('invite-modal')).toBeInTheDocument();
  });
});

// ---- around now ------------------------------------------------------------

describe('Around now', () => {
  it('names who is where rather than saying the room is quiet', async () => {
    light('v1', [voiceState({ user_id: '1', username: 'mara' })]);
    renderLobby();
    const well = screen.getByRole('region', { name: 'Around now' });
    await waitFor(() => expect(within(well).getByText(/are in|is in/)).toBeInTheDocument());
    expect(well.textContent).not.toMatch(/No data|It's quiet/i);
  });

  it('says nobody is on rather than showing an empty strip', () => {
    usePresenceStore.getState().reset();
    renderLobby();
    const well = screen.getByRole('region', { name: 'Around now' });
    expect(within(well).getByText("Nobody's lights are on right now")).toBeInTheDocument();
  });
});

// ---- the rooms grid --------------------------------------------------------

describe('the rooms grid', () => {
  it('draws a lit card for an occupied room and a matte one for an empty room', async () => {
    light('v1', [voiceState({ user_id: '1', username: 'mara' })]);
    renderLobby();

    const rooms = screen.getByRole('region', { name: 'Rooms' });
    await waitFor(() => expect(within(rooms).getByText('LIVE')).toBeInTheDocument());
    expect(within(rooms).getByRole('button', { name: 'Join Shop floor' })).toBeInTheDocument();
    expect(within(rooms).getByText(/Dark · nobody's in/)).toBeInTheDocument();
    expect(within(rooms).getByRole('button', { name: 'Open Lounge' })).toBeInTheDocument();
  });

  it('puts the lit room before the dark one', async () => {
    light('v2', [voiceState({ user_id: '1', username: 'mara' })]);
    renderLobby();
    const rooms = screen.getByRole('region', { name: 'Rooms' });
    await waitFor(() => expect(within(rooms).getByText('LIVE')).toBeInTheDocument());
    const names = within(rooms)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(['Lounge', 'Shop floor']);
  });

  it('joins a room when the lights go on', () => {
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Open Lounge' }));
    expect(gates.joinChannel).toHaveBeenCalledWith('v2', GUILD);
  });

  it('omits the add tile for somebody who cannot open a room', () => {
    renderLobby();
    expect(screen.queryByRole('button', { name: 'Open a new room' })).not.toBeInTheDocument();
  });

  it('offers the add tile to somebody who can, and sends them where rooms are made', () => {
    gates.permissions = Permissions.MANAGE_CHANNELS;
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Open a new room' }));
    expect(useUIStore.getState().guildSettingsId).toBe(GUILD);
    expect(useUIStore.getState().guildSettingsInitialSection).toBe('channels');
  });
});

// ---- coming up and the media strip ----------------------------------------

describe('Coming up', () => {
  it('is omitted entirely when the calendar is empty', async () => {
    renderLobby();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Coming up' })).not.toBeInTheDocument();
  });

  it('shows the next event, where it is, and lets the reader say they are going', async () => {
    api.events = [
      {
        id: 'e1',
        name: 'Thermal test — driver v3',
        scheduled_start: new Date(Date.now() + 3_600_000).toISOString(),
        status: 1,
        channel_id: 'v1',
        creator_id: '2',
        user_count: 6,
        user_rsvp: false,
      },
    ];
    renderLobby();

    const card = await screen.findByRole('region', { name: 'Coming up' });
    expect(within(card).getByText('Thermal test — driver v3')).toBeInTheDocument();
    expect(within(card).getByText(/Shop floor/).textContent).toContain('6 going');
    // The header picks up the same event, so the two never disagree.
    expect(screen.getByText(/Thermal test — driver v3 at /)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: "I'm going" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(`/guilds/${GUILD}/events/e1/rsvp`),
    );
    await screen.findByRole('button', { name: "You're going" });
  });

  it('stays quiet when the calendar cannot be read', async () => {
    api.get.mockRejectedValue(new Error('offline'));
    renderLobby();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Coming up' })).not.toBeInTheDocument();
  });
});

describe('the media strip', () => {
  it('is omitted entirely when no images have been shared in the loaded rooms', () => {
    renderLobby();
    expect(screen.queryByRole('region', { name: /Recently in/ })).not.toBeInTheDocument();
  });
});

// ---- text rooms ------------------------------------------------------------

describe('text rooms', () => {
  it('renders them as rows, never as cards, and keeps voice rooms out', () => {
    renderLobby();
    const list = screen.getByRole('region', { name: 'Text rooms' });
    expect(within(list).getByText('build-log')).toBeInTheDocument();
    expect(within(list).getByText('firmware')).toBeInTheDocument();
    expect(within(list).queryByText('Shop floor')).not.toBeInTheDocument();
  });

  it('carries the mention chip and opens the room', () => {
    gates.mentions = new Map([['t1', 1]]);
    renderLobby();
    const list = screen.getByRole('region', { name: 'Text rooms' });
    expect(within(list).getByText('1 mention')).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('button', { name: /build-log/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(
      `/app/guilds/${GUILD}/channels/t1`,
    );
  });

  it('lights a text room amber when somebody is typing in it', async () => {
    act(() => {
      useTypingStore.setState({ typingByChannel: { t1: ['1', '2'] } });
    });
    renderLobby();
    const list = screen.getByRole('region', { name: 'Text rooms' });
    await waitFor(() => expect(within(list).getByText('2 reading')).toBeInTheDocument());
  });
});
