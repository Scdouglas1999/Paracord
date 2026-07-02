import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import { inviteApi } from '../api/invites';
import { toast } from '../stores/toastStore';
import { DiscoveryPage } from './DiscoveryPage';

const mockGuildState = vi.hoisted(() => ({
  guilds: [] as Array<{ id: string; name: string }>,
  addGuild: vi.fn(),
}));

const mockChannelState = vi.hoisted(() => ({
  channelsByGuild: {
    'guild-1': [{ id: 'channel-1', guild_id: 'guild-1', type: 0, name: 'general' }],
  } as Record<string, Array<{ id: string; guild_id: string; type: number; name: string }>>,
  fetchChannels: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiClient: {
    get: vi.fn(),
  },
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'Request failed'),
}));

vi.mock('../api/invites', () => ({
  inviteApi: {
    accept: vi.fn(),
  },
}));

vi.mock('../stores/toastStore', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../stores/guildStore', () => {
  const useGuildStore = Object.assign(
    (selector: (state: typeof mockGuildState) => unknown) => selector(mockGuildState),
    {
      getState: vi.fn(() => mockGuildState),
    },
  );
  return { useGuildStore };
});

vi.mock('../stores/channelStore', () => ({
  useChannelStore: {
    getState: vi.fn(() => mockChannelState),
  },
}));

const discoverableGuild = {
  id: 'guild-1',
  name: 'Launch Guild',
  description: 'Public launch planning.',
  icon_hash: null,
  member_count: 42,
  online_count: 7,
  tags: ['Technology'],
  created_at: '2026-05-17T00:00:00Z',
};

function renderDiscoveryPage() {
  render(
    <MemoryRouter initialEntries={['/app/discovery']}>
      <Routes>
        <Route path="/app/discovery" element={<DiscoveryPage />} />
        <Route path="/app" element={<div>Home route</div>} />
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<div>Guild channel route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DiscoveryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGuildState.guilds = [];
    mockChannelState.channelsByGuild = {
      'guild-1': [{ id: 'channel-1', guild_id: 'guild-1', type: 0, name: 'general' }],
    };
    mockChannelState.fetchChannels.mockResolvedValue(undefined);
    vi.mocked(apiClient.get).mockImplementation((url: string) => {
      if (url.startsWith('/discovery/guilds')) {
        return Promise.resolve({ data: { guilds: [discoverableGuild], total: 1 } });
      }
      if (url === '/guilds/guild-1/invites') {
        return Promise.resolve({ data: [{ code: 'invite-1' }] });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
    vi.mocked(inviteApi.accept).mockResolvedValue({
      data: { guild: { id: 'guild-1', name: 'Launch Guild', default_channel_id: null } },
    } as never);
  });

  it('shows a retryable load error instead of pretending discovery is empty', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ data: { guilds: [discoverableGuild], total: 1 } } as never);

    renderDiscoveryPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load public servers: network down');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Launch Guild' })).toBeInTheDocument();
  });

  it('joins a public server through its public invite and opens the first text channel', async () => {
    const user = userEvent.setup();

    renderDiscoveryPage();

    expect(await screen.findByRole('heading', { name: 'Launch Guild' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(inviteApi.accept).toHaveBeenCalledWith('invite-1');
    });
    expect(mockGuildState.addGuild).toHaveBeenCalledWith({
      id: 'guild-1',
      name: 'Launch Guild',
      default_channel_id: null,
    });
    expect(mockChannelState.fetchChannels).toHaveBeenCalledWith('guild-1');
    expect(toast.success).toHaveBeenCalledWith('Joined Launch Guild!');
    expect(await screen.findByText('Guild channel route')).toBeInTheDocument();
  });

  it('has an accessible back action and reports when no public invite is available', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockImplementation((url: string) => {
      if (url.startsWith('/discovery/guilds')) {
        return Promise.resolve({ data: { guilds: [discoverableGuild], total: 1 } });
      }
      if (url === '/guilds/guild-1/invites') {
        return Promise.resolve({ data: [] });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    renderDiscoveryPage();

    expect(await screen.findByRole('button', { name: 'Back to home' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('No public invite available for this server.');
    });
    expect(inviteApi.accept).not.toHaveBeenCalled();
  });

  it('shows concrete join errors when public invite lookup fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockImplementation((url: string) => {
      if (url.startsWith('/discovery/guilds')) {
        return Promise.resolve({ data: { guilds: [discoverableGuild], total: 1 } });
      }
      if (url === '/guilds/guild-1/invites') {
        return Promise.reject(new Error('Public invites are temporarily unavailable.'));
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    renderDiscoveryPage();

    expect(await screen.findByRole('heading', { name: 'Launch Guild' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to join server: Public invites are temporarily unavailable.',
      );
    });
    expect(inviteApi.accept).not.toHaveBeenCalled();
  });
});
