import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dmApi } from '../api/dms';
import { toast } from '../stores/toastStore';
import { HomePage } from './HomePage';

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
  guilds: [] as Array<{ id: string; name: string }>,
  selectGuild: vi.fn(),
}));

const mockRelationshipState = vi.hoisted(() => ({
  relationships: [{ id: 'rel-1', type: 1, user: testData.friend }],
  fetchRelationships: vi.fn(),
}));

const mockPresenceState = vi.hoisted(() => ({
  presences: new Map(),
  getPresence: vi.fn(() => ({ user_id: 'friend-1', status: 'online', activities: [] })),
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
}));

const mockVoiceState = vi.hoisted(() => ({
  channelParticipants: new Map(),
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
  usePresenceStore: (selector: (state: typeof mockPresenceState) => unknown) =>
    selector(mockPresenceState),
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

vi.mock('../stores/serverListStore', () => ({
  useServerListStore: (selector: (state: typeof mockServerListState) => unknown) =>
    selector(mockServerListState),
}));

vi.mock('../stores/voiceStore', () => ({
  useVoiceStore: (selector: (state: typeof mockVoiceState) => unknown) =>
    selector(mockVoiceState),
}));

vi.mock('../components/guild/CreateGuildModal', () => ({
  CreateGuildModal: () => <div>Create server modal</div>,
}));

vi.mock('../components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function renderHomePage() {
  render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app" element={<HomePage />} />
        <Route path="/app/dms/:channelId" element={<div>DM route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGuildState.guilds = [];
    mockRelationshipState.relationships = [{ id: 'rel-1', type: 1, user: testData.friend }];
    mockPresenceState.getPresence.mockReturnValue({
      user_id: 'friend-1',
      status: 'online',
      activities: [],
    });
    mockChannelState.channelsByGuild = { '': [] };
    mockChannelState.fetchChannels.mockResolvedValue(undefined);
    mockRelationshipState.fetchRelationships.mockResolvedValue(undefined);
  });

  it('opens an online friend DM from the dashboard', async () => {
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

    await user.click(await screen.findByRole('button', { name: /Grace/ }));

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

    await user.click(await screen.findByRole('button', { name: /Grace/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to open direct message: Server unavailable',
      );
    });
    expect(mockChannelState.selectChannel).not.toHaveBeenCalled();
  });
});
