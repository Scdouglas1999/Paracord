import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../api/dms';
import { FriendsPage } from './FriendsPage';

vi.mock('../components/user/UserProfile', () => ({
  UserProfilePopup: ({ user, onClose }: { user: { username: string } | null; onClose: () => void }) =>
    user === null ? null : (
      <div data-testid="friend-profile">
        Profile for {user.username}
        <button type="button" onClick={onClose}>Close profile</button>
      </div>
    ),
}));

const testData = vi.hoisted(() => ({
  friend: {
    id: 'friend-1',
    username: 'Grace',
    discriminator: 1,
    flags: 0,
    bot: false,
    system: false,
    created_at: '2026-05-17T00:00:00Z',
  },
  ada: {
    id: 'ada-id',
    username: 'Ada',
    discriminator: 2,
    flags: 0,
    bot: false,
    system: false,
    created_at: '2026-05-17T00:00:00Z',
  },
  bea: {
    id: 'bea-id',
    username: 'Bea',
    discriminator: 3,
    flags: 0,
    bot: false,
    system: false,
    created_at: '2026-05-17T00:00:00Z',
  },
}));

const mockRelationshipState = vi.hoisted(() => ({
  relationships: [{ id: 'rel-1', type: 1, user: testData.friend }] as Array<{
    id: string;
    type: number;
    user: typeof testData.friend;
  }>,
  fetchRelationships: vi.fn(),
  addFriend: vi.fn(),
  acceptFriend: vi.fn(),
  removeFriend: vi.fn(),
}));

const mockPresenceState = vi.hoisted(() => ({
  presences: new Map(),
  getPresence: vi.fn(() => ({ user_id: 'friend-1', status: 'online', activities: [] })),
}));

const mockServerListState = vi.hoisted(() => ({
  activeServerId: null as string | null,
}));

const mockChannelState = vi.hoisted(() => ({
  channelsByGuild: {
    '': [],
  } as Record<string, Array<Record<string, unknown>>>,
  setDmChannels: vi.fn(),
  createDm: vi.fn(),
  createGroupDm: vi.fn(),
  selectChannel: vi.fn(),
}));

// Who is in a call, for the amber line under a friend: covered where the light
// models are (lib/attention); this suite is about the page.
// A face draws its picture from an authenticated URL; the download ticket is not this suite's business.
vi.mock('../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));
const lightState = vi.hoisted(() => ({ buildings: [] as unknown[] }));
vi.mock('../hooks/useLights', () => ({ useBuildingLights: () => lightState.buildings }));

vi.mock('../api/dms', () => ({
  dmApi: {
    create: vi.fn(),
  },
}));

vi.mock('../api/client', () => ({
  extractApiError: (err: unknown) =>
    err instanceof Error ? err.message : 'Request failed',
}));

vi.mock('../stores/relationshipStore', () => {
  const useRelationshipStore = Object.assign(
    (selector: (state: typeof mockRelationshipState) => unknown) =>
      selector(mockRelationshipState),
    {
      getState: vi.fn(() => mockRelationshipState),
    },
  );
  return { useRelationshipStore };
});

vi.mock('../stores/presenceStore', () => ({
  usePresenceStore: (selector: (state: typeof mockPresenceState) => unknown) =>
    selector(mockPresenceState),
}));

vi.mock('../stores/serverListStore', () => ({
  useServerListStore: (selector: (state: typeof mockServerListState) => unknown) =>
    selector(mockServerListState),
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

function renderFriendsPage() {
  render(
    <MemoryRouter initialEntries={['/app/friends']}>
      <Routes>
        <Route path="/app/friends" element={<FriendsPage />} />
        <Route path="/app/dms/:channelId" element={<div>DM route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FriendsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lightState.buildings = [];
    mockChannelState.createDm.mockImplementation(async (id, scope) => {
      const { data } = await dmApi.create(id);
      return { ...data, scope, key: JSON.stringify([scope.serverId, scope.userId, data.id]) };
    });
    mockRelationshipState.relationships = [{ id: 'rel-1', type: 1, user: testData.friend }];
    mockRelationshipState.fetchRelationships.mockResolvedValue(undefined);
    mockRelationshipState.addFriend.mockResolvedValue(undefined);
    mockRelationshipState.acceptFriend.mockResolvedValue(undefined);
    mockRelationshipState.removeFriend.mockResolvedValue(undefined);
    mockPresenceState.getPresence.mockReturnValue({
      user_id: 'friend-1',
      status: 'online',
      activities: [],
    });
    mockChannelState.channelsByGuild = { '': [] };
  });

  it('labels friend search and shows inline feedback when opening a DM fails', async () => {
    const user = userEvent.setup();
    vi.mocked(dmApi.create).mockRejectedValue(new Error('Server unavailable'));

    renderFriendsPage();

    expect(screen.getByRole('searchbox', { name: /search friends/i })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /message grace/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    expect(mockChannelState.selectChannel).not.toHaveBeenCalled();
  });

  it('calls the tab Online, the word the presence module uses', async () => {
    renderFriendsPage();
    // The filter tab, the section's kicker and the row's own line all come
    // from the one presence vocabulary in lib/presence.
    expect(await screen.findByRole('tab', { name: /^Online/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Online' })).toHaveTextContent(/Online\s*1/);
    // The tab, the kicker and the online friend's line: the same word, from one place.
    expect(screen.getAllByText('Online')).toHaveLength(3);
    expect(screen.queryByText(/lights (on|off)/i)).not.toBeInTheDocument();
  });

  it('makes the friend identity row a profile target while keeping Message visible', async () => {
    const user = userEvent.setup();
    renderFriendsPage();

    expect(screen.getByRole('button', { name: 'Message Grace' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open profile for Grace' }));
    expect(screen.getByTestId('friend-profile')).toHaveTextContent('Profile for Grace');

    await user.click(screen.getByRole('button', { name: 'Close profile' }));
    expect(screen.queryByTestId('friend-profile')).not.toBeInTheDocument();
  });

  it('surfaces Add friend as a header primary action, not a filter tab', async () => {
    const user = userEvent.setup();
    renderFriendsPage();

    // The add flow is a prominent header button, not one of the filter pills.
    const addButton = screen.getByRole('button', { name: /^add friend$/i });
    expect(addButton).toHaveAttribute('aria-expanded', 'false');
    // The input is hidden until the primary action is invoked.
    expect(screen.queryByRole('textbox', { name: /username or user id/i })).not.toBeInTheDocument();

    await user.click(addButton);
    expect(addButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: /username or user id/i })).toBeInTheDocument();
  });

  it('prevents duplicate friend requests while a send is already pending', async () => {
    const user = userEvent.setup();
    let resolveAddFriend!: () => void;
    mockRelationshipState.addFriend.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAddFriend = resolve;
        }),
    );

    renderFriendsPage();

    await user.click(screen.getByRole('button', { name: /^add friend$/i }));
    await user.type(screen.getByRole('textbox', { name: /username or user id/i }), '  Ada  ');

    const sendButton = screen.getByRole('button', { name: /send friend request/i });
    await user.click(sendButton);

    expect(mockRelationshipState.addFriend).toHaveBeenCalledTimes(1);
    expect(mockRelationshipState.addFriend).toHaveBeenCalledWith('Ada');
    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /sending/i }));
    expect(mockRelationshipState.addFriend).toHaveBeenCalledTimes(1);

    resolveAddFriend();

    // Simulate the store refresh that follows a successful add.
    mockRelationshipState.relationships = [
      ...mockRelationshipState.relationships,
      { id: 'rel-ada', type: 4, user: testData.ada },
    ];
    mockRelationshipState.fetchRelationships.mockResolvedValue(undefined);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Friend request sent to Ada!');
    });
  });

  it('splits requests into Incoming/Outgoing sections with counts and accept/decline', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [
      { id: 'in-1', type: 3, user: testData.ada },
      { id: 'out-1', type: 4, user: testData.bea },
    ];

    renderFriendsPage();

    // The Requests pill carries the combined pending count.
    const requestsTab = screen.getByRole('tab', { name: /requests/i });
    expect(within(requestsTab).getByText('2')).toBeInTheDocument();

    await user.click(requestsTab);

    expect(screen.getByRole('region', { name: 'Incoming' })).toHaveTextContent(/Incoming\s*1/);
    expect(screen.getByRole('region', { name: 'Outgoing' })).toHaveTextContent(/Outgoing\s*1/);

    // Incoming requests get accept + decline; outgoing gets cancel.
    expect(screen.getByRole('button', { name: /accept friend request from ada/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline friend request from ada/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel friend request to bea/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /accept friend request from ada/i }));
    expect(mockRelationshipState.acceptFriend).toHaveBeenCalledWith('ada-id');
  });

  describe('who is here, drawn as the places panel draws people', () => {
    const friendOf = (id: string, username: string) => ({
      id: `rel-${id}`,
      type: 1,
      user: { ...testData.friend, id, username },
    });

    function seedPresence(byId: Record<string, { status: string; activities?: unknown[]; custom_status?: string }>) {
      mockPresenceState.getPresence.mockImplementation(((id: string) =>
        byId[id] ? { user_id: id, activities: [], ...byId[id] } : undefined) as never);
    }

    it('says where a friend is in amber, and puts people in a call first', async () => {
      const user = userEvent.setup();
      mockRelationshipState.relationships = [friendOf('a', 'Ada'), friendOf('b', 'Bea'), friendOf('c', 'Cy')];
      seedPresence({ a: { status: 'online' }, b: { status: 'online' }, c: { status: 'idle' } });
      lightState.buildings = [
        { name: 'Game Night', rooms: [{ kind: 'voice', name: 'Lounge', occupants: [{ person: { userId: 'c' } }] }] },
      ];
      renderFriendsPage();
      await user.click(screen.getByRole('tab', { name: /^All/ }));
      const rows = screen.getAllByRole('button', { name: /^Open profile for/ });
      // Cy is in a call, so leads even though Ada and Bea are more "online" and sort earlier by name.
      expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
        'Open profile for Cy',
        'Open profile for Ada',
        'Open profile for Bea',
      ]);
      const cy = rows[0];
      expect(cy).toHaveTextContent('Away');
      expect(cy).toHaveTextContent('In Lounge, Game Night');
      expect(cy.querySelector('.glass-prow__voice')).not.toBeNull();
      expect(cy.querySelector('.glass-presence')).toHaveAttribute('data-live');
    });

    it('says what somebody is doing, in their words first', async () => {
      const user = userEvent.setup();
      mockRelationshipState.relationships = [friendOf('a', 'Ada'), friendOf('b', 'Bea')];
      seedPresence({
        a: { status: 'online', activities: [{ type: 0, name: 'Hazard 5' }] },
        b: { status: 'online', custom_status: 'Back at nine' },
      });
      renderFriendsPage();
      await user.click(screen.getByRole('tab', { name: /^All/ }));
      expect(screen.getByRole('button', { name: 'Open profile for Ada' })).toHaveTextContent('Online · Playing Hazard 5');
      expect(screen.getByRole('button', { name: 'Open profile for Bea' })).toHaveTextContent('Online · Back at nine');
    });

    it('draws presence as ink and steps an offline friend back', async () => {
      const user = userEvent.setup();
      mockRelationshipState.relationships = [friendOf('a', 'Ada'), friendOf('b', 'Bea'), friendOf('c', 'Cy'), friendOf('d', 'Dot')];
      seedPresence({ a: { status: 'online' }, b: { status: 'idle' }, c: { status: 'dnd' } });
      const { container } = render(
        <MemoryRouter initialEntries={['/app/friends']}>
          <Routes>
            <Route path="/app/friends" element={<FriendsPage />} />
          </Routes>
        </MemoryRouter>,
      );
      await user.click(screen.getByRole('tab', { name: /^All/ }));
      const statuses = [...container.querySelectorAll('.glass-presence')].map((mark) => mark.getAttribute('data-status'));
      expect(statuses).toEqual(['online', 'idle', 'dnd', 'offline']);
      const offline = screen.getByRole('button', { name: 'Open profile for Dot' }).closest('li');
      expect(offline).toHaveAttribute('data-offline');
      expect(screen.getByRole('button', { name: 'Open profile for Dot' })).toHaveTextContent('Offline');
    });

    it('lets you take back a block as text, and never draws presence for a blocked person', async () => {
      const user = userEvent.setup();
      mockRelationshipState.relationships = [{ id: 'rel-x', type: 2, user: { ...testData.friend, id: 'x', username: 'Xan' } }];
      const { container } = render(
        <MemoryRouter initialEntries={['/app/friends']}>
          <Routes>
            <Route path="/app/friends" element={<FriendsPage />} />
          </Routes>
        </MemoryRouter>,
      );
      await user.click(screen.getByRole('tab', { name: /^Blocked/ }));
      expect(container.querySelector('.glass-presence')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Unblock Xan' }));
      expect(mockRelationshipState.removeFriend).toHaveBeenCalledWith('x');
    });

    it('keeps the add-friend submit as the page’s one filled button', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <MemoryRouter initialEntries={['/app/friends']}>
          <Routes>
            <Route path="/app/friends" element={<FriendsPage />} />
          </Routes>
        </MemoryRouter>,
      );
      await user.click(screen.getByRole('button', { name: /^add friend$/i }));
      expect(screen.getByRole('button', { name: /^add friend$/i })).toHaveClass('bg-[var(--glass-fill)]');
      expect(container.querySelectorAll('.bg-accent-primary')).toHaveLength(1);
      expect(screen.getByRole('button', { name: /send friend request/i })).toHaveClass('bg-accent-primary');
    });
  });

  it('renders a left-aligned empty state that points at the Add friend action', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [];

    renderFriendsPage();

    await user.click(screen.getByRole('tab', { name: /^all$/i }));
    expect(screen.getByText('Your friends list is empty')).toBeInTheDocument();

    // The empty-state CTA opens the same add-friend input.
    await user.click(screen.getByRole('button', { name: /add your first friend/i }));
    expect(screen.getByRole('textbox', { name: /username or user id/i })).toBeInTheDocument();
  });
});

vi.mock('../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChannels')>('../hooks/useChannels');
  const { useChannelStore } = await import('../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore(state => state.channelsByGuild[id] ?? []),
  };
});

vi.mock('../lib/channelNavigation', () => ({ activateChannel: (channel: { id: string }) => mockChannelState.selectChannel(channel.id) }));

vi.mock('../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => ({ serverId: '__local__', userId: 'me' }),
  // Your face at the pane's edge (the page bar) reads you, not the friends.
  useCurrentUser: () => null,
}));
