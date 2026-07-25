import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
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
    put: vi.fn(),
  },
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'Request failed'),
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
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
    vi.mocked(apiClient.put).mockResolvedValue({
      data: { id: 'guild-1', name: 'Launch Guild', default_channel_id: null },
    } as never);
  });

  it('shows a retryable load error instead of pretending discovery is empty', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ data: { guilds: [discoverableGuild], total: 1 } } as never);

    renderDiscoveryPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load public spaces: network down');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Launch Guild' })).toBeInTheDocument();
  });

  it('requests federated discovery results', async () => {
    renderDiscoveryPage();
    await screen.findByRole('heading', { name: 'Launch Guild' });
    expect(apiClient.get).toHaveBeenCalledWith(
      expect.stringContaining('include_federated=true'),
      // Requests now carry an abort signal so a superseded search is cancelled.
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('previews a public server before joining and opens the first text channel after confirmation', async () => {
    const user = userEvent.setup();

    renderDiscoveryPage();

    expect(await screen.findByRole('heading', { name: 'Launch Guild' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    const dialog = screen.getByRole('dialog', { name: 'Launch Guild' });
    expect(dialog).toHaveTextContent('Public launch planning.');
    expect(dialog).toHaveTextContent('Joining adds this space to your sidebar');
    expect(apiClient.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Join Launch Guild' }));

    await waitFor(() => {
      expect(apiClient.put).toHaveBeenCalledWith('/guilds/guild-1/members/@me');
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

  it('has an accessible back action and lets the user dismiss a preview without joining', async () => {
    const user = userEvent.setup();

    renderDiscoveryPage();

    expect(await screen.findByRole('button', { name: 'Back to home' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog', { name: 'Launch Guild' })).not.toBeInTheDocument();
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it('shows concrete join errors inside the preview and keeps it open for retry', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.put).mockRejectedValue(new Error('Membership service is temporarily unavailable.'));

    renderDiscoveryPage();

    expect(await screen.findByRole('heading', { name: 'Launch Guild' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(screen.getByRole('button', { name: 'Join Launch Guild' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't join this space: Membership service is temporarily unavailable.",
    );
    expect(screen.getByRole('dialog', { name: 'Launch Guild' })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('identifies federated listings and does not offer a join action that cannot work', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        guilds: [{ ...discoverableGuild, id: 'peer.example:guild-1', federated: true, origin_server: 'peer.example' }],
        total: 1,
      },
    } as never);

    renderDiscoveryPage();
    await user.click(await screen.findByRole('button', { name: 'Preview' }));

    expect(screen.getByRole('dialog', { name: 'Launch Guild' })).toHaveTextContent('From peer.example');
    expect(screen.getByText(/Cross-server joining is not available/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join Launch Guild/i })).toBeNull();
  });
});
