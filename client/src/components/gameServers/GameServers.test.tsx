import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gameServersApi, type GameServer } from '../../api/gameServers';
import { useGameServerStore } from '../../stores/gameServerStore';
import { GameServersSection } from './GameServersSection';
import { GameServersSidebarRow } from './GameServersSidebarRow';

vi.mock('../../api/gameServers', async () => {
  const actual = await vi.importActual<typeof import('../../api/gameServers')>('../../api/gameServers');
  return {
    ...actual,
    gameServersApi: { list: vi.fn(), setEnabled: vi.fn(), preview: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  };
});
vi.mock('../../hooks/useChannels', () => ({ useGuildChannels: () => [] }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const smp: GameServer = {
  id: 's1',
  guild_id: 'g1',
  kind: 'minecraft_java',
  name: 'Lantern SMP',
  address: 'play.lantern.test:25565',
  created_at: '2026-09-24T10:00:00Z',
  announce_channel_id: null,
  status: {
    state: 'up',
    players_online: 5,
    players_max: 20,
    player_names: ['mira_builds', 'jonas'],
    version: 'Paper 1.21.1',
    latency_ms: 12,
    last_checked_at: new Date().toISOString(),
  },
};

const tf2: GameServer = {
  id: 's2',
  guild_id: 'g1',
  kind: 'source',
  name: 'Lantern TF2',
  address: '203.0.113.10:27015',
  created_at: '2026-09-24T10:00:00Z',
  announce_channel_id: null,
  status: { state: 'down', error: 'No answer within 3 seconds.', last_seen_online: null },
};

describe('GameServersSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGameServerStore.getState().reset();
  });

  it('offers to add the first one when the list is empty', async () => {
    vi.mocked(gameServersApi.list).mockResolvedValue({
      data: { enabled: true, can_manage: true, limit: 10, servers: [] },
    } as never);
    render(<GameServersSection guildId="g1" />);
    expect(await screen.findByText('No game servers yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a game server' })).toBeInTheDocument();
  });

  it('shows each server as up or down, with the reason', async () => {
    vi.mocked(gameServersApi.list).mockResolvedValue({
      data: { enabled: true, can_manage: true, limit: 10, servers: [smp, tf2] },
    } as never);
    render(<GameServersSection guildId="g1" />);
    expect(await screen.findByText('Lantern SMP')).toBeInTheDocument();
    expect(screen.getByText(/5\/20 online · Paper 1.21.1 · 12 ms/)).toBeInTheDocument();
    expect(screen.getByText('No answer within 3 seconds.')).toBeInTheDocument();
    expect(screen.getByText('2 of 10')).toBeInTheDocument();
  });

  it('turns the add-on on', async () => {
    const user = userEvent.setup();
    vi.mocked(gameServersApi.list).mockResolvedValue({
      data: { enabled: false, can_manage: true, limit: 10, servers: [] },
    } as never);
    vi.mocked(gameServersApi.setEnabled).mockResolvedValue({ data: { enabled: true } } as never);
    render(<GameServersSection guildId="g1" />);
    const toggle = await screen.findByRole('switch', { name: 'Game servers on this server' });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await user.click(toggle);
    expect(gameServersApi.setEnabled).toHaveBeenCalledWith('g1', true);
  });
});

describe('GameServersSidebarRow', () => {
  it('counts the ones up and lists each with copy, and connect for Steam games', async () => {
    const user = userEvent.setup();
    render(<GameServersSidebarRow guildName="Lantern Works" servers={[smp, { ...tf2, status: { state: 'up', players_online: 4, players_max: 24, map: 'ctf_2fort' } }]} />);
    expect(screen.getByLabelText('2 of 2 up')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Game servers/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Lantern Works game servers' });
    expect(dialog).toHaveTextContent('5/20 online');
    expect(dialog).toHaveTextContent('4/24 online · ctf_2fort');
    const connects = screen.getAllByRole('link', { name: 'Connect' });
    expect(connects).toHaveLength(1);
    expect(connects[0]).toHaveAttribute('href', 'steam://connect/203.0.113.10:27015');
    expect(screen.getByRole('button', { name: 'Copy the address of Lantern SMP' })).toBeInTheDocument();
  });
});
