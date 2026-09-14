import { useAuthStore } from '../stores/authStore';
import { guildLandingPath } from '../lib/guildNavigation';
vi.mock('../lib/guildNavigation', () => ({ guildLandingPath: vi.fn() }));
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import { toast } from '../stores/toastStore';
import { DiscoveryPage } from './DiscoveryPage';

const mockGuildState = vi.hoisted(() => ({
  guilds: [] as Array<{ id: string; name: string }>,
  joinPublic: vi.fn(),
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
    useAuthStore.setState({ user: { id: 'user-1' } as never, token: 'token' });
    mockGuildState.joinPublic.mockResolvedValue({ id: 'guild-1', name: 'Launch Guild', scope: { serverId: '__local__', userId: 'user-1' } });
    vi.mocked(guildLandingPath).mockResolvedValue('/app/guilds/guild-1/channels/channel-1');
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

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load public servers: network down');
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
    expect(dialog).toHaveTextContent('Joining adds this server to your sidebar');
    expect(apiClient.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Join Launch Guild' }));

    await waitFor(() => {
      expect(mockGuildState.joinPublic).toHaveBeenCalledWith('guild-1', { serverId: '__local__', userId: 'user-1' });
    });
    expect(guildLandingPath).toHaveBeenCalledWith(expect.objectContaining({ id: 'guild-1', scope: { serverId: '__local__', userId: 'user-1' } }));
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
    mockGuildState.joinPublic.mockRejectedValue(new Error('Membership service is temporarily unavailable.'));

    renderDiscoveryPage();

    expect(await screen.findByRole('heading', { name: 'Launch Guild' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(screen.getByRole('button', { name: 'Join Launch Guild' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't join this server: Membership service is temporarily unavailable.",
    );
    expect(screen.getByRole('dialog', { name: 'Launch Guild' })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('carries the category chips a 44px hit area on a coarse pointer', () => {
    // §9: a chip a thumb has to hit is 44px even when its ink is 28. `pc-touch`
    // (primitives.css, `@media (pointer: coarse)`) is the mechanism — the same
    // one the Friends filter chips use. jsdom has no layout, so the guard is
    // that the class is on the chip: without it there is no hit area to grow.
    renderDiscoveryPage();
    const chip = screen.getByRole('button', { name: 'Gaming' });
    expect(chip.className).toContain('pc-touch');
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
    expect(screen.getByText(/Cross-instance joining is not available/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join Launch Guild/i })).toBeNull();
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
