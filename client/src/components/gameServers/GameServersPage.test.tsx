import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gameServersApi, type GameServer } from '../../api/gameServers';
import { useGameServerStore } from '../../stores/gameServerStore';
import { useToolbarStore } from '../ix/shell/toolbarStore';
import { useUIStore } from '../../stores/uiStore';
import { GameServersPage } from './GameServersPage';
import { gameServersHref, isGameServersPath } from './gameServerModel';

vi.mock('../../api/gameServers', async () => {
  const actual = await vi.importActual<typeof import('../../api/gameServers')>('../../api/gameServers');
  return { ...actual, gameServersApi: { list: vi.fn(), setEnabled: vi.fn(), preview: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } };
});
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
  status: { state: 'up', players_online: 4, players_max: 24, map: 'ctf_2fort', last_checked_at: new Date().toISOString() },
};
const down: GameServer = { ...tf2, id: 's3', name: 'Old box', kind: 'tcp', status: { state: 'down', error: 'No answer within 3 seconds.', last_seen_online: null } };

function list(servers: GameServer[], over: Record<string, unknown> = {}) {
  vi.mocked(gameServersApi.list).mockResolvedValue({
    data: { enabled: true, can_manage: false, limit: 10, servers, ...over },
  } as never);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <GameServersPage guildId="g1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useGameServerStore.getState().reset();
  useToolbarStore.setState({ page: null, owner: null });
  useUIStore.setState({ guildSettingsId: null, guildSettingsInitialSection: null });
});
afterEach(cleanup);

describe('the Game servers page', () => {
  it('is a large-title page: the title, how many are up, and the toolbar told', async () => {
    list([smp, tf2, down]);
    renderPage();
    expect(await screen.findByText('Lantern SMP')).toBeInTheDocument();
    expect(screen.getByTestId('ix-title')).toHaveTextContent('Game servers');
    expect(screen.getByText('2 of 3 up')).toBeInTheDocument();
    expect(useToolbarStore.getState().page?.title).toBe('Game servers');
  });

  it('lists each server with its state in words, what was seen, copy, and connect for Steam games only', async () => {
    const user = userEvent.setup();
    list([smp, tf2, down]);
    renderPage();
    const cards = await screen.findAllByRole('listitem', { name: /Lantern|Old box/ });
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent(/Up/);
    expect(cards[0]).toHaveTextContent('5/20 online · Paper 1.21.1 · 12 ms');
    expect(within(cards[0]).queryByText('Connect')).toBeNull();
    expect(within(cards[1]).getByText('Connect').closest('a')).toHaveAttribute('href', 'steam://connect/203.0.113.10:27015');
    expect(cards[1]).toHaveTextContent('4/24 online · ctf_2fort');
    expect(cards[2]).toHaveTextContent('Down');
    expect(cards[2]).toHaveTextContent('No answer within 3 seconds.');
    await act(async () => {
      await user.click(within(cards[0]).getByRole('button', { name: 'Copy the address of Lantern SMP' }));
    });
    expect(within(cards[0]).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('shows who is on as one group named by the players', async () => {
    list([smp]);
    renderPage();
    // Five are on and the game named two: the group says so in words.
    expect(await screen.findByRole('img', { name: 'On now: mira_builds, jonas and 3 more' })).toBeInTheDocument();
  });

  it('offers a manager the way to add the first one, in settings', async () => {
    const user = userEvent.setup();
    list([], { can_manage: true });
    renderPage();
    expect(await screen.findByText('No game servers yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a game server' }));
    expect(useUIStore.getState().guildSettingsId).toBe('g1');
    expect(useUIStore.getState().guildSettingsInitialSection).toBe('sports');
  });

  it('tells a member, without a button, that there are none', async () => {
    list([]);
    renderPage();
    expect(await screen.findByText('No game servers yet')).toBeInTheDocument();
    expect(screen.getByText('Nobody has added a game server here yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a game server' })).toBeNull();
  });

  it('says when the add-on is off', async () => {
    list([], { enabled: false, can_manage: true });
    renderPage();
    expect(await screen.findByText('Game servers are off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument();
  });

  it('has a route that mirrors Sports and Daily word', () => {
    expect(gameServersHref('g1')).toBe('/app/guilds/g1/game-servers');
    expect(isGameServersPath('g1', '/app/guilds/g1/game-servers')).toBe(true);
    expect(isGameServersPath('g1', '/app/guilds/g1/game-servers/')).toBe(true);
    expect(isGameServersPath('g1', '/app/guilds/g2/game-servers')).toBe(false);
    expect(isGameServersPath('g1', '/app/guilds/g1')).toBe(false);
  });
});
