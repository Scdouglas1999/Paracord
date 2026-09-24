import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyWordApi } from '../../api/dailyWord';
import { feedsApi } from '../../api/feeds';
import { gameServersApi } from '../../api/gameServers';
import { sportsApi } from '../../api/sports';
import { AddonsHub } from './AddonsHub';

vi.mock('../../api/feeds', async () => {
  const actual = await vi.importActual<typeof import('../../api/feeds')>('../../api/feeds');
  return {
    ...actual,
    feedsApi: { list: vi.fn(), setEnabled: vi.fn(), preview: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), postLatest: vi.fn() },
  };
});

vi.mock('../../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../../api/sports')>('../../api/sports');
  return {
    ...actual,
    sportsApi: { getSettings: vi.fn(), updateSettings: vi.fn(), listLeagues: vi.fn(), getBoard: vi.fn(), listTeams: vi.fn() },
  };
});

vi.mock('../../api/dailyWord', async () => {
  const actual = await vi.importActual<typeof import('../../api/dailyWord')>('../../api/dailyWord');
  return {
    ...actual,
    dailyWordApi: { ...actual.dailyWordApi, getSettings: vi.fn(), updateSettings: vi.fn() },
  };
});
vi.mock('../../api/gameServers', async () => {
  const actual = await vi.importActual<typeof import('../../api/gameServers')>('../../api/gameServers');
  return {
    ...actual,
    gameServersApi: { list: vi.fn(), setEnabled: vi.fn(), preview: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const feedList = { enabled: false, feeds: [], limit: 20, twitch_available: false };

describe('AddonsHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(feedsApi.list).mockResolvedValue({ data: feedList } as never);
    vi.mocked(feedsApi.setEnabled).mockResolvedValue({ data: { enabled: true } } as never);
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: {
        guild_id: 'g1', enabled: true, leagues: ['football/nfl'], favorite_teams: [],
        show_on_server_page: true, default_view: 'all', updated_at: '2026-09-21T12:00:00Z',
      },
    } as never);
    vi.mocked(dailyWordApi.getSettings).mockResolvedValue({
      data: { guild_id: 'g1', enabled: false, share_channel_id: null, show_on_front_page: true, updated_at: '' },
    } as never);
    vi.mocked(gameServersApi.list).mockResolvedValue({
      data: { enabled: true, can_manage: true, limit: 10, servers: [] },
    } as never);
    vi.mocked(sportsApi.listLeagues).mockResolvedValue({ data: { leagues: [] } } as never);
  });

  it('lists every add-on with its switch and a way in', async () => {
    render(<AddonsHub guildId="g1" />);
    expect(screen.getByRole('heading', { name: 'Sports' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Feeds' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Daily word' })).toBeInTheDocument();
    const feedsSwitch = await screen.findByRole('switch', { name: 'Feeds on this server' });
    await waitFor(() => expect(feedsSwitch).not.toBeDisabled());
    expect(feedsSwitch).toHaveAttribute('aria-checked', 'false');
    expect(await screen.findByRole('switch', { name: 'Sports on this server' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('heading', { name: 'Game servers' })).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: 'Game servers on this server' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('button', { name: /Set up/ })).toHaveLength(4);
  });

  it('turns an add-on on from its card', async () => {
    const user = userEvent.setup();
    render(<AddonsHub guildId="g1" />);
    const feedsSwitch = await screen.findByRole('switch', { name: 'Feeds on this server' });
    await waitFor(() => expect(feedsSwitch).not.toBeDisabled());
    await user.click(feedsSwitch);
    expect(feedsApi.setEnabled).toHaveBeenCalledWith('g1', true);
    await waitFor(() => expect(feedsSwitch).toHaveAttribute('aria-checked', 'true'));
  });

  it('opens an add-on page and comes back', async () => {
    const user = userEvent.setup();
    render(<AddonsHub guildId="g1" initialAddon="feeds" />);
    expect(await screen.findByText(/Turn Feeds on to add feeds/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add-ons' }));
    expect(screen.getByRole('heading', { name: 'Add-ons' })).toBeInTheDocument();
  });
});
