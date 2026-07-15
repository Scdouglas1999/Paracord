import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../api/dms';
import { toast } from '../stores/toastStore';
import { HomePage } from './HomePage';
import type { ConversationEntry } from '../lib/attention/conversationModel';
import type { GuildSummary } from '../hooks/useUnifiedConversations';

const testData = vi.hoisted(() => ({
  currentUser: {
    id: 'user-1',
    username: 'Ada',
    discriminator: 1,
    flags: 0,
    bot: false,
    system: false,
    created_at: '2026-05-17T00:00:00Z',
  },
  friend: {
    id: 'friend-1',
    username: 'Grace',
    discriminator: 1,
    flags: 0,
    bot: false,
    system: false,
    created_at: '2026-05-17T00:00:00Z',
  },
}));

const mockAuthState = vi.hoisted(() => ({
  user: testData.currentUser,
}));

const mockGuildState = vi.hoisted(() => ({
  guilds: [] as Array<{ id: string; name: string; member_count?: number }>,
  selectGuild: vi.fn(),
  selectedGuildId: null as string | null,
}));

const mockRelationshipState = vi.hoisted(() => ({
  relationships: [{ id: 'rel-1', type: 1, user: testData.friend }],
  fetchRelationships: vi.fn(),
}));

const mockPresenceState = vi.hoisted(() => ({
  presences: new Map(),
  getPresence: vi.fn(() => ({
    user_id: 'friend-1',
    status: 'online',
    activities: [] as Array<{ name: string; type: number }>,
  })),
}));

const mockChannelState = vi.hoisted(() => ({
  channelsByGuild: {
    '': [],
  } as Record<string, Array<Record<string, unknown>>>,
  fetchChannels: vi.fn(),
  setDmChannels: vi.fn(),
  selectChannel: vi.fn(),
  selectGuild: vi.fn(),
}));

const mockServerListState = vi.hoisted(() => ({
  activeServerId: null as string | null,
  setActive: vi.fn(),
}));

const mockVoiceState = vi.hoisted(() => ({
  channelParticipants: new Map<string, unknown[]>(),
  speakingUsers: new Set<string>(),
  setWatchedStreamer: vi.fn(),
}));

const mockUnified = vi.hoisted(() => ({
  needsYou: [] as ConversationEntry[],
  recent: [] as ConversationEntry[],
  pinned: [] as ConversationEntry[],
  spaces: [] as GuildSummary[],
  requests: [] as Array<{ key: string; userId: string; username: string; createdMs: number | null }>,
}));

vi.mock('../api/dms', () => ({
  dmApi: {
    create: vi.fn(),
  },
}));

vi.mock('../api/client', () => ({
  extractApiError: (err: unknown) =>
    err instanceof Error ? err.message : 'Request failed',
}));

vi.mock('../stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (state: typeof mockAuthState) => unknown) =>
    selector(mockAuthState),
}));

vi.mock('../stores/guildStore', () => ({
  useGuildStore: (selector: (state: typeof mockGuildState) => unknown) =>
    selector(mockGuildState),
}));

vi.mock('../stores/relationshipStore', () => ({
  useRelationshipStore: (selector: (state: typeof mockRelationshipState) => unknown) =>
    selector(mockRelationshipState),
}));

vi.mock('../stores/presenceStore', () => ({
  usePresenceStore: Object.assign(
    (selector: (state: typeof mockPresenceState) => unknown) => selector(mockPresenceState),
    { getState: () => mockPresenceState },
  ),
}));

vi.mock('../stores/channelStore', () => {
  const useChannelStore = Object.assign(
    (selector: (state: typeof mockChannelState) => unknown) => selector(mockChannelState),
    {
      getState: vi.fn(() => mockChannelState),
    },
  );
  return { useChannelStore };
});

vi.mock('../stores/serverListStore', () => {
  const useServerListStore = Object.assign(
    (selector: (state: typeof mockServerListState) => unknown) =>
      selector(mockServerListState),
    { getState: () => mockServerListState },
  );
  return { useServerListStore };
});

vi.mock('../stores/voiceStore', () => {
  const useVoiceStore = Object.assign(
    (selector: (state: typeof mockVoiceState) => unknown) => selector(mockVoiceState),
    { getState: vi.fn(() => mockVoiceState) },
  );
  return { useVoiceStore };
});

vi.mock('../hooks/useVoice', () => ({
  useVoice: () => ({ joinChannel: vi.fn() }),
}));

vi.mock('../hooks/useMutedGuilds', () => ({
  useMutedGuilds: () => ({ mutedGuildIds: [] as string[] }),
}));

vi.mock('../hooks/useUnifiedConversations', () => ({
  useUnifiedConversations: () => mockUnified,
}));

// RoomCard is exercised in its own suite — here we assert HomePage renders one
// per live room and passes the resolved title through.
vi.mock('../components/rooms/RoomCard', () => ({
  RoomCard: ({ channel }: { channel: { name?: string } }) => (
    <div data-testid="room-card">{channel.name}</div>
  ),
}));

vi.mock('../components/message/DmPickerModal', () => ({
  DmPickerModal: ({ open }: { open: boolean }) =>
    open ? <div>DM picker dialog</div> : null,
}));

vi.mock('../components/guild/CreateGuildModal', () => ({
  CreateGuildModal: () => <div>Create server modal</div>,
}));

vi.mock('../components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function makeRecentEntry(
  overrides: Partial<ConversationEntry> = {},
): ConversationEntry {
  return {
    key: 'local:dm-1',
    serverId: 'local',
    channelId: 'dm-1',
    guildId: null,
    userId: 'friend-1',
    avatar: null,
    kind: 'dm',
    title: 'Grace',
    contextLabel: null,
    lastActivityId: '900',
    unread: false,
    mentionCount: 0,
    isDMUnread: false,
    isThreadReply: false,
    hasVoiceActivity: false,
    pinned: false,
    ...overrides,
  };
}

function renderHomePage() {
  render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app" element={<HomePage />} />
        <Route path="/app/dms/:channelId" element={<div>DM route</div>} />
        <Route path="/app/friends" element={<div>Friends route</div>} />
        <Route path="/app/guilds/:guildId" element={<div>Guild home route</div>} />
        <Route
          path="/app/guilds/:guildId/channels/:channelId"
          element={<div>Guild channel route</div>}
        />
        <Route path="/app/discovery" element={<div>Discovery route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGuildState.guilds = [];
    mockGuildState.selectedGuildId = null;
    mockRelationshipState.relationships = [{ id: 'rel-1', type: 1, user: testData.friend }];
    mockPresenceState.getPresence.mockReturnValue({
      user_id: 'friend-1',
      status: 'online',
      activities: [],
    });
    mockChannelState.channelsByGuild = { '': [] };
    mockChannelState.fetchChannels.mockResolvedValue(undefined);
    mockChannelState.selectGuild.mockResolvedValue(undefined);
    mockRelationshipState.fetchRelationships.mockResolvedValue(undefined);
    mockVoiceState.channelParticipants = new Map();
    mockVoiceState.speakingUsers = new Set();
    mockUnified.needsYou = [];
    mockUnified.recent = [];
    mockUnified.pinned = [];
    mockUnified.spaces = [];
    mockUnified.requests = [];
  });

  it('renders live DM calls in Happening now when a call is active', () => {
    mockChannelState.channelsByGuild = {
      '': [
        {
          id: 'dm-1',
          type: 1,
          position: 0,
          nsfw: false,
          created_at: '2026-05-17T00:00:00Z',
          last_message_id: '900',
          recipient: testData.friend,
        },
      ],
    };
    mockVoiceState.channelParticipants = new Map([
      ['dm-1', [{ user_id: 'friend-1', username: 'Grace', self_stream: false, suppress: false }]],
    ]);

    renderHomePage();

    expect(screen.getByText('Happening now')).toBeInTheDocument();
    const card = screen.getByTestId('room-card');
    expect(card).toHaveTextContent('Grace');
    expect(screen.queryByText('Nothing pulsing just yet')).not.toBeInTheDocument();
    // Starting something remains reachable even while a call is live.
    expect(screen.getByLabelText('Jump in')).toBeInTheDocument();
    expect(screen.getByText('Jump in')).toBeInTheDocument();
  });

  it('includes occupied guild voice rooms in Happening now', () => {
    mockGuildState.guilds = [{ id: 'guild-1', name: 'Emerald HQ' }];
    mockChannelState.channelsByGuild = {
      '': [],
      'guild-1': [
        {
          id: 'voice-1',
          type: 2,
          name: 'Lounge',
          position: 0,
          nsfw: false,
          created_at: '2026-05-17T00:00:00Z',
        },
      ],
    };
    mockVoiceState.channelParticipants = new Map([
      [
        'voice-1',
        [
          {
            user_id: 'friend-1',
            username: 'Grace',
            guild_id: 'guild-1',
            self_stream: false,
            suppress: false,
          },
        ],
      ],
    ]);

    renderHomePage();

    expect(screen.getByText('Happening now')).toBeInTheDocument();
    expect(screen.getByText('in Emerald HQ')).toBeInTheDocument();
    expect(screen.getByTestId('room-card')).toHaveTextContent('Lounge');
  });

  it('keeps the primary-space continuation visible while friends are online', () => {
    mockGuildState.guilds = [{ id: 'guild-1', name: 'Emerald HQ', member_count: 4 }];
    mockGuildState.selectedGuildId = 'guild-1';
    mockUnified.spaces = [
      { id: 'guild-1', name: 'Emerald HQ', icon: null, serverId: 'local' },
    ];

    renderHomePage();

    expect(screen.getByLabelText('Around now')).toBeInTheDocument();
    expect(screen.getByLabelText('Continue in Emerald HQ')).toBeInTheDocument();
    expect(screen.getByLabelText('Jump in')).toBeInTheDocument();
  });

  it('shows Around now as an avatar strip and Pick up from unified recent', () => {
    mockUnified.recent = [makeRecentEntry()];

    renderHomePage();

    expect(screen.getByLabelText('Around now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Message Grace/ })).toBeInTheDocument();
    const pickUp = screen.getByLabelText('Pick up');
    expect(pickUp).toBeInTheDocument();
    expect(pickUp).toHaveTextContent('Grace');
  });

  it('composes a quiet canvas with resume hero, pick up, spaces, and jump-in', () => {
    mockPresenceState.getPresence.mockReturnValue({
      user_id: 'friend-1',
      status: 'offline',
      activities: [],
    });
    mockRelationshipState.relationships = [];
    mockGuildState.guilds = [{ id: 'guild-1', name: 'Fuel', member_count: 4 }];
    mockGuildState.selectedGuildId = 'guild-1';
    mockUnified.spaces = [{ id: 'guild-1', name: 'Fuel', icon: null, serverId: 'local' }];
    mockUnified.recent = [
      makeRecentEntry({
        key: 'local:ch-general',
        channelId: 'ch-general',
        guildId: 'guild-1',
        kind: 'guild_text',
        title: 'general',
        contextLabel: 'Fuel',
        lastActivityId: '800',
        userId: null,
      }),
      makeRecentEntry({
        key: 'local:dm-vinc',
        channelId: 'dm-vinc',
        title: 'Vinc',
        lastActivityId: '100',
      }),
    ];

    renderHomePage();

    // No barren EmptyState — deliberate quiet composition.
    expect(screen.queryByText('Nothing pulsing just yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Happening now')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Around now')).not.toBeInTheDocument();

    // Resume hero for primary space.
    expect(screen.getByLabelText('Continue in Fuel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enter space/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume #general/ })).toBeInTheDocument();

    // Pick up + Your spaces + Start something fill the page.
    expect(screen.getByLabelText('Pick up')).toHaveTextContent('general');
    expect(screen.getByLabelText('Your spaces')).toBeInTheDocument();
    expect(screen.getByLabelText('Jump in')).toBeInTheDocument();
    expect(screen.getByText('Start something')).toBeInTheDocument();
    // Header + Jump-in both expose New message.
    expect(screen.getAllByRole('button', { name: /New message/ }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /Add a friend/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Explore spaces/ })).toBeInTheDocument();

    // Quiet status copy names the primary space.
    expect(screen.getByText(/Fuel is quiet/)).toBeInTheDocument();
  });

  it('opens the primary space from the resume hero', async () => {
    const user = userEvent.setup();
    mockPresenceState.getPresence.mockReturnValue({
      user_id: 'friend-1',
      status: 'offline',
      activities: [],
    });
    mockRelationshipState.relationships = [];
    mockGuildState.guilds = [{ id: 'guild-1', name: 'Fuel', member_count: 2 }];
    mockUnified.spaces = [{ id: 'guild-1', name: 'Fuel', icon: null, serverId: 'local' }];

    renderHomePage();

    await user.click(screen.getByRole('button', { name: /Enter space/ }));

    await waitFor(() => {
      expect(mockGuildState.selectGuild).toHaveBeenCalledWith('guild-1');
    });
    expect(await screen.findByText('Guild home route')).toBeInTheDocument();
  });

  it('shows jump-in for a brand-new quiet account without cloning EmptyStates', () => {
    mockPresenceState.getPresence.mockReturnValue({
      user_id: 'friend-1',
      status: 'offline',
      activities: [],
    });
    mockRelationshipState.relationships = [];

    renderHomePage();

    expect(screen.queryByText('Nothing pulsing just yet')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Jump in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create a space/ })).toBeInTheDocument();
    expect(
      screen.getByText(/When friends come online or a call starts/),
    ).toBeInTheDocument();
  });

  it('surfaces a friend-request pulse without rebuilding the Friends tab', () => {
    mockRelationshipState.relationships = [
      { id: 'rel-1', type: 1, user: testData.friend },
      {
        id: 'req-1',
        type: 3,
        user: {
          id: 'req-user',
          username: 'Pending',
          discriminator: 1,
          flags: 0,
          bot: false,
          system: false,
          created_at: '2026-05-17T00:00:00Z',
        },
      },
    ];

    renderHomePage();

    expect(screen.getByRole('button', { name: /1 friend request waiting/ })).toBeInTheDocument();
  });

  it('opens the DM picker from the "New message" affordance', async () => {
    const user = userEvent.setup();
    renderHomePage();

    expect(screen.queryByText('DM picker dialog')).not.toBeInTheDocument();
    // Header CTA — first match when Jump-in also has New message.
    await user.click(screen.getAllByRole('button', { name: /New message/ })[0]!);
    expect(screen.getByText('DM picker dialog')).toBeInTheDocument();
  });

  it('opens an online friend DM from the around-now strip', async () => {
    const user = userEvent.setup();
    const dmChannel = {
      id: 'dm-1',
      type: 1,
      position: 0,
      nsfw: false,
      created_at: '2026-05-17T00:00:00Z',
      recipient: testData.friend,
    };
    vi.mocked(dmApi.create).mockResolvedValue({ data: dmChannel } as never);

    renderHomePage();

    await user.click(await screen.findByRole('button', { name: /Message Grace/ }));

    await waitFor(() => {
      expect(dmApi.create).toHaveBeenCalledWith('friend-1');
    });
    expect(mockChannelState.setDmChannels).toHaveBeenCalledWith([dmChannel]);
    expect(mockChannelState.selectChannel).toHaveBeenCalledWith('dm-1');
    expect(await screen.findByText('DM route')).toBeInTheDocument();
  });

  it('shows feedback when opening an online friend DM fails', async () => {
    const user = userEvent.setup();
    vi.mocked(dmApi.create).mockRejectedValue(new Error('Server unavailable'));

    renderHomePage();

    await user.click(await screen.findByRole('button', { name: /Message Grace/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to open direct message: Server unavailable',
      );
    });
    expect(mockChannelState.selectChannel).not.toHaveBeenCalled();
  });

  it('shows Your spaces with attention dots for live guild rooms', () => {
    mockGuildState.guilds = [{ id: 'guild-1', name: 'Emerald HQ', member_count: 12 }];
    mockUnified.spaces = [
      { id: 'guild-1', name: 'Emerald HQ', icon: null, serverId: 'local' },
    ];
    mockChannelState.channelsByGuild = {
      '': [],
      'guild-1': [
        {
          id: 'voice-1',
          type: 2,
          name: 'Lounge',
          position: 0,
          nsfw: false,
          created_at: '2026-05-17T00:00:00Z',
        },
      ],
    };
    mockVoiceState.channelParticipants = new Map([
      [
        'voice-1',
        [
          {
            user_id: 'friend-1',
            username: 'Grace',
            guild_id: 'guild-1',
            self_stream: false,
            suppress: false,
          },
        ],
      ],
    ]);

    renderHomePage();

    expect(screen.getByText('Your spaces')).toBeInTheDocument();
    expect(screen.getByTestId('home-server-attention')).toBeInTheDocument();
  });
});
