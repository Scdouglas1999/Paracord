import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../api/dms';
import { FriendsPage } from './FriendsPage';

vi.mock('../components/user/UserProfile', () => ({
  UserProfilePopup: ({ user, onClose }: { user: { username: string }; onClose: () => void }) => (
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
  selectChannel: vi.fn(),
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

    expect(screen.getByRole('textbox', { name: /search friends/i })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /message grace/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    expect(mockChannelState.selectChannel).not.toHaveBeenCalled();
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
    const requestsTab = screen.getByRole('button', { name: /requests/i });
    expect(within(requestsTab).getByText('2')).toBeInTheDocument();

    await user.click(requestsTab);

    expect(screen.getByText('Incoming — 1')).toBeInTheDocument();
    expect(screen.getByText('Outgoing — 1')).toBeInTheDocument();

    // Incoming requests get accept + decline; outgoing gets cancel.
    expect(screen.getByRole('button', { name: /accept friend request from ada/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline friend request from ada/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel friend request to bea/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /accept friend request from ada/i }));
    expect(mockRelationshipState.acceptFriend).toHaveBeenCalledWith('ada-id');
  });

  it('renders a left-aligned empty state that points at the Add friend action', async () => {
    const user = userEvent.setup();
    mockRelationshipState.relationships = [];

    renderFriendsPage();

    await user.click(screen.getByRole('button', { name: /^all$/i }));
    expect(screen.getByText('Your friends list is empty')).toBeInTheDocument();

    // The empty-state CTA opens the same add-friend input.
    await user.click(screen.getByRole('button', { name: /add your first friend/i }));
    expect(screen.getByRole('textbox', { name: /username or user id/i })).toBeInTheDocument();
  });
});
