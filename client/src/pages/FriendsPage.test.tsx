import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../api/dms';
import { FriendsPage } from './FriendsPage';

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
}));

const mockRelationshipState = vi.hoisted(() => ({
  relationships: [{ id: 'rel-1', type: 1, user: testData.friend }],
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

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Friend request sent to Ada!');
    });
  });
});
