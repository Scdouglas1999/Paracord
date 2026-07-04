import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChannelType, type Channel, type Member, type VoiceState } from '../types';
import { GuildHomePage } from './GuildHomePage';

// ---- store mocks ----------------------------------------------------------

const mockState = vi.hoisted(() => ({
  guilds: [] as Array<{ id: string; name: string; owner_id: string; server_url?: string }>,
  channelsByGuild: {} as Record<string, Channel[]>,
  channelParticipants: new Map<string, VoiceState[]>(),
  speakingUsers: new Set<string>(),
  members: new Map<string, Member[]>(),
  presence: new Map<string, string>(), // userId → status
  isChannelUnread: new Set<string>(),
  channelMentionCounts: new Map<string, number>(),
  permissions: 0n,
  isAdmin: false,
  isOwner: false,
  guildSettingsId: null as string | null,
  contextPanelMode: null as string | null,
}));

vi.mock('../stores/guildStore', () => ({
  useGuildStore: Object.assign(
    (selector: (s: { guilds: typeof mockState.guilds }) => unknown) =>
      selector({ guilds: mockState.guilds }),
    { getState: () => ({ guilds: mockState.guilds }) },
  ),
}));

vi.mock('../stores/channelStore', () => ({
  useChannelStore: (
    selector: (s: {
      channelsByGuild: Record<string, Channel[]>;
      fetchChannels: () => Promise<void>;
    }) => unknown,
  ) => selector({ channelsByGuild: mockState.channelsByGuild, fetchChannels: vi.fn() }),
}));

vi.mock('../stores/voiceStore', () => ({
  useVoiceStore: Object.assign(
    (
      selector: (s: {
        channelParticipants: Map<string, VoiceState[]>;
        speakingUsers: Set<string>;
        setWatchedStreamer: () => void;
      }) => unknown,
    ) =>
      selector({
        channelParticipants: mockState.channelParticipants,
        speakingUsers: mockState.speakingUsers,
        setWatchedStreamer: vi.fn(),
      }),
    { getState: () => ({ setWatchedStreamer: vi.fn() }) },
  ),
}));

vi.mock('../stores/memberStore', () => ({
  useMemberStore: (
    selector: (s: {
      members: Map<string, Member[]>;
      fetchMembers: () => Promise<void>;
    }) => unknown,
  ) => selector({ members: mockState.members, fetchMembers: vi.fn() }),
}));

vi.mock('../stores/presenceStore', () => ({
  usePresenceStore: (
    selector: (s: {
      presences: Map<string, unknown>;
      getPresence: (userId: string) => { status: string } | undefined;
    }) => unknown,
  ) =>
    selector({
      presences: new Map(),
      getPresence: (userId: string) => {
        const status = mockState.presence.get(userId);
        return status ? { status } : undefined;
      },
    }),
}));

vi.mock('../stores/serverListStore', () => ({
  useServerListStore: (
    selector: (s: {
      activeServerId: string | null;
      getServerByUrl: () => undefined;
    }) => unknown,
  ) => selector({ activeServerId: 'srv-1', getServerByUrl: () => undefined }),
}));

vi.mock('../stores/uiStore', () => ({
  useUIStore: (
    selector: (s: {
      setGuildSettingsId: (id: string | null) => void;
      setContextPanelMode: (mode: string | null) => void;
    }) => unknown,
  ) =>
    selector({
      setGuildSettingsId: (id) => {
        mockState.guildSettingsId = id;
      },
      setContextPanelMode: (mode) => {
        mockState.contextPanelMode = mode;
      },
    }),
}));

vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: mockState.permissions,
    isAdmin: mockState.isAdmin,
    isOwner: mockState.isOwner,
  }),
}));

vi.mock('../hooks/useUnreadCounts', () => ({
  useUnreadCounts: () => ({
    isChannelUnread: mockState.isChannelUnread,
    channelMentionCounts: mockState.channelMentionCounts,
  }),
}));

// InviteModal reaches into API/clipboard on mount; stub it out for the header test.
vi.mock('../components/guild/InviteModal', () => ({
  InviteModal: () => <div data-testid="invite-modal" />,
}));

// ---- helpers --------------------------------------------------------------

function chan(overrides: Partial<Channel> & { id: string }): Channel {
  return {
    guild_id: 'guild-1',
    name: overrides.name ?? overrides.id,
    type: ChannelType.Text,
    position: 0,
    nsfw: false,
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  } as Channel;
}

function vs(partial: Partial<VoiceState> & { user_id: string }): VoiceState {
  return {
    session_id: `session-${partial.user_id}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    ...partial,
  } as VoiceState;
}

function member(id: string, name: string): Member {
  return {
    user: {
      id,
      username: name,
      discriminator: 0,
      bot: false,
      system: false,
      flags: 0,
      created_at: '',
    },
    roles: [],
    joined_at: '',
    deaf: false,
    mute: false,
  } as Member;
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1']}>
      <Routes>
        <Route path="/app/guilds/:guildId" element={<GuildHomePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockState.guilds = [{ id: 'guild-1', name: 'Emerald HQ', owner_id: 'owner-1' }];
  mockState.channelsByGuild = { 'guild-1': [] };
  mockState.channelParticipants = new Map();
  mockState.speakingUsers = new Set();
  mockState.members = new Map();
  mockState.presence = new Map();
  mockState.isChannelUnread = new Set();
  mockState.channelMentionCounts = new Map();
  mockState.permissions = 0n;
  mockState.isAdmin = false;
  mockState.isOwner = false;
  mockState.guildSettingsId = null;
  mockState.contextPanelMode = null;
});

afterEach(() => cleanup());

describe('GuildHomePage (Rooms view)', () => {
  it('renders the guild name in the header', () => {
    renderHome();
    expect(screen.getByRole('heading', { name: 'Emerald HQ' })).toBeInTheDocument();
  });

  it('selects the live card for an occupied room and a compact row for a quiet one', () => {
    mockState.channelsByGuild = {
      'guild-1': [
        chan({ id: 'v-live', name: 'Lounge', type: ChannelType.Voice }),
        chan({ id: 'v-quiet', name: 'AFK', type: ChannelType.Voice }),
      ],
    };
    mockState.channelParticipants = new Map([
      ['v-live', [vs({ user_id: 'u1', username: 'Alice' })]],
    ]);

    renderHome();

    // Live room → occupant avatar rendered (speaking-ring capable stack).
    expect(screen.getByLabelText('Alice')).toBeInTheDocument();
    // Quiet room → compact "Empty — start the room" affordance, not a dead tile.
    expect(screen.getByText('Empty — start the room')).toBeInTheDocument();
  });

  it('applies the speaking ring to a speaking occupant', () => {
    mockState.channelsByGuild = {
      'guild-1': [chan({ id: 'v-live', name: 'Lounge', type: ChannelType.Voice })],
    };
    mockState.channelParticipants = new Map([
      ['v-live', [vs({ user_id: 'u1', username: 'Alice' })]],
    ]);
    mockState.speakingUsers = new Set(['u1']);

    renderHome();

    const avatar = screen.getByLabelText('Alice (speaking)');
    expect(avatar.className).toContain('ring-accent-primary');
  });

  it('shows online members in the around-now strip and opens the member panel via View all', () => {
    mockState.channelsByGuild = { 'guild-1': [] };
    mockState.members = new Map([['guild-1', [member('u1', 'Alice'), member('u2', 'Bob')]]]);
    mockState.presence = new Map([
      ['u1', 'online'],
      ['u2', 'offline'],
    ]);

    renderHome();

    const strip = screen.getByRole('region', { name: 'Around now' });
    // Only the online member surfaces.
    expect(within(strip).getByLabelText('Alice')).toBeInTheDocument();
    expect(within(strip).queryByLabelText('Bob')).not.toBeInTheDocument();

    fireEvent.click(within(strip).getByRole('button', { name: 'View all' }));
    expect(mockState.contextPanelMode).toBe('members');
  });

  it('groups text channels and keeps voice channels out of the text list', () => {
    mockState.channelsByGuild = {
      'guild-1': [
        chan({ id: 't-general', name: 'general', type: ChannelType.Text }),
        chan({ id: 'v-voice', name: 'Voice', type: ChannelType.Voice }),
      ],
    };

    renderHome();

    const list = screen.getByRole('region', { name: 'Text channels' });
    expect(within(list).getByText('general')).toBeInTheDocument();
    // Voice channels never appear in the text list.
    expect(within(list).queryByText('Voice')).not.toBeInTheDocument();
  });

  it('hides the settings gear without MANAGE_GUILD', () => {
    mockState.channelsByGuild = { 'guild-1': [chan({ id: 't-1', name: 'general' })] };
    renderHome();
    expect(screen.queryByRole('button', { name: 'Server settings' })).not.toBeInTheDocument();
  });

  it('shows the MANAGE_GUILD-gated gear and opens guild settings', () => {
    mockState.channelsByGuild = { 'guild-1': [chan({ id: 't-1', name: 'general' })] };
    mockState.isOwner = true;
    renderHome();

    const gear = screen.getByRole('button', { name: 'Server settings' });
    fireEvent.click(gear);
    expect(mockState.guildSettingsId).toBe('guild-1');
  });
});
