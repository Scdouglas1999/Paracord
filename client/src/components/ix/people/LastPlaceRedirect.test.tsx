import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LastPlaceRedirect } from './LastPlaceRedirect';
import { PLACE_MEMORY_KEY } from './lastPlace';

/**
 * `/app` and `/app/dms` as routes (docs/index-spec.md §8.1): what they do while the lists they need are
 * on their way, and where they land. The rule itself is in lastPlace.test.ts.
 */

const world = vi.hoisted(() => ({
  userId: 'me' as string | null,
  guilds: [] as Array<{ id: string; name: string; scope: unknown }>,
  channels: [] as Array<{ id: string; guild_id: string | null; last_message_id: string | null }>,
  loadDms: vi.fn<() => Promise<void>>(),
  fetchGuilds: vi.fn<(scope: unknown) => Promise<void>>(),
  landing: vi.fn<(guild: { id: string }) => Promise<string>>(),
  toast: vi.fn(),
}));

vi.mock('../../../hooks/useCurrentUser', () => ({ useCurrentUser: () => (world.userId ? { id: world.userId } : null) }));
vi.mock('../../../hooks/useGuilds', () => ({ useAvailableGuilds: () => world.guilds }));
vi.mock('../../../hooks/useChannels', () => ({ useAvailableChannels: () => world.channels }));
vi.mock('../../../hooks/useAvailableAccountScopes', () => ({ useAvailableAccountScopes: () => (world.userId ? [{ serverId: 'srv', userId: 'me' }] : []) }));
vi.mock('../../../stores/channelStore', () => ({ useChannelStore: { getState: () => ({ loadAllDmChannels: world.loadDms }) } }));
vi.mock('../../../stores/guildStore', () => ({ useGuildStore: { getState: () => ({ fetchGuilds: world.fetchGuilds }) } }));
vi.mock('../../../lib/guildNavigation', () => ({ guildLandingPath: (guild: { id: string }) => world.landing(guild) }));
vi.mock('../../../stores/toastStore', () => ({ toast: { error: world.toast } }));
vi.mock('../../../api/client', () => ({ extractApiError: (error: unknown) => (error instanceof Error ? error.message : 'failed') }));

const EPOCH_MS = 1704067200000;
const idAt = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();
const NOW = new Date(2026, 9, 1, 21, 38).getTime();

function Where() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

function renderAt(path: '/app' | '/app/dms') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app" element={<LastPlaceRedirect mode="app" />} />
        <Route path="/app/dms" element={<LastPlaceRedirect mode="dms" />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const remember = (memory: Record<string, unknown>) => window.localStorage.setItem(PLACE_MEMORY_KEY, JSON.stringify(memory));
const where = () => screen.getByTestId('where');

beforeEach(() => {
  window.localStorage.clear();
  world.userId = 'me';
  world.guilds = [
    { id: 'g1', name: 'Fuel', scope: { serverId: 'srv', userId: 'me' } },
    { id: 'g2', name: 'Game Night', scope: { serverId: 'srv', userId: 'me' } },
  ];
  world.channels = [
    { id: 'old', guild_id: null, last_message_id: idAt(NOW - 86_400_000) },
    { id: 'new', guild_id: null, last_message_id: idAt(NOW - 1_000) },
    { id: 'chan', guild_id: 'g1', last_message_id: idAt(NOW) },
  ];
  world.loadDms.mockReset().mockResolvedValue(undefined);
  world.fetchGuilds.mockReset().mockResolvedValue(undefined);
  world.landing.mockReset().mockImplementation(async (guild) => `/app/guilds/${guild.id}/channels/landing`);
  world.toast.mockReset();
});

describe('LastPlaceRedirect', () => {
  it('draws nothing but a status while it finds where you were', () => {
    world.loadDms.mockReturnValue(new Promise(() => {}));
    world.guilds = [];
    renderAt('/app');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Opening where you left off');
  });

  it('before there is an account to ask as, it asks nothing and decides nothing (no servers would be a guess)', () => {
    world.userId = null;
    world.guilds = [];
    world.channels = [];
    renderAt('/app');
    expect(world.loadDms).not.toHaveBeenCalled();
    expect(world.fetchGuilds).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('while the server you were in is still connecting it goes nowhere, then opens your channel when it arrives', async () => {
    // A launch where the saved server's connect is still in flight (or being retried): there is no
    // account to ask as yet, so it must not land on that server's route (the pane would be dead) nor
    // give the place up for People.
    remember({ userId: 'me', place: 'g2', path: '/app/guilds/g2/channels/lounge', people: '/app/friends', serverId: 'srv' });
    world.userId = null;
    world.guilds = [];
    const view = renderAt('/app');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId('where')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();

    world.userId = 'me';
    world.guilds = [{ id: 'g2', name: 'Game Night', scope: { serverId: 'srv', userId: 'me' } }];
    view.rerender(
      <MemoryRouter initialEntries={['/app']}>
        <Routes>
          <Route path="/app" element={<LastPlaceRedirect mode="app" />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(where()).toHaveTextContent('/app/guilds/g2/channels/lounge'));
  });

  it('/app opens the channel you were in', async () => {
    remember({ userId: 'me', place: 'g2', path: '/app/guilds/g2/channels/lounge', people: null });
    renderAt('/app');
    await waitFor(() => expect(where()).toHaveTextContent('/app/guilds/g2/channels/lounge'));
  });

  it('/app opens the landing channel of the server you were in when no channel was remembered', async () => {
    remember({ userId: 'me', place: 'g2', path: null, people: null });
    renderAt('/app');
    await waitFor(() => expect(where()).toHaveTextContent('/app/guilds/g2/channels/landing'));
    expect(world.landing).toHaveBeenCalledWith(expect.objectContaining({ id: 'g2' }));
  });

  it('/app with nothing remembered opens your first server', async () => {
    renderAt('/app');
    await waitFor(() => expect(where()).toHaveTextContent('/app/guilds/g1/channels/landing'));
  });

  it('asks for the servers and the conversations (and does not decide before they answer)', async () => {
    let answer: () => void = () => {};
    world.fetchGuilds.mockReturnValue(new Promise<void>((resolve) => { answer = resolve; }));
    world.guilds = [];
    remember({ userId: 'me', place: 'g1', path: '/app/guilds/g1/channels/c', people: '/app/friends' });
    renderAt('/app');
    expect(world.loadDms).toHaveBeenCalledTimes(1);
    expect(world.fetchGuilds).toHaveBeenCalledWith({ serverId: 'srv', userId: 'me' });
    expect(screen.getByRole('status')).toBeInTheDocument();
    // The server turns out not to be yours any more: People opens.
    answer();
    await waitFor(() => expect(where()).toHaveTextContent('/app/friends'));
  });

  it('a server that has arrived by the time it is asked about is opened without waiting for the answer', async () => {
    world.fetchGuilds.mockReturnValue(new Promise(() => {}));
    remember({ userId: 'me', place: 'g1', path: '/app/guilds/g1/channels/c', people: null });
    renderAt('/app');
    await waitFor(() => expect(where()).toHaveTextContent('/app/guilds/g1/channels/c'));
  });

  it('a server you left is gone: the last People item opens instead', async () => {
    remember({ userId: 'me', place: 'g9', path: '/app/guilds/g9/channels/c', people: '/app/dms/old' });
    renderAt('/app');
    await waitFor(() => expect(where()).toHaveTextContent('/app/dms/old'));
  });

  it('another account\'s memory is not used', async () => {
    remember({ userId: 'someone', place: 'g2', path: '/app/guilds/g2/channels/c', people: null });
    renderAt('/app');
    await waitFor(() => expect(where()).toHaveTextContent('/app/guilds/g1/channels/landing'));
  });

  it('/app/dms opens the most recent conversation when there is nothing to go back to', async () => {
    renderAt('/app/dms');
    await waitFor(() => expect(where()).toHaveTextContent('/app/dms/new'));
  });

  it('/app/dms goes back to Friends when that is where you were', async () => {
    remember({ userId: 'me', place: 'people', path: null, people: '/app/friends' });
    renderAt('/app/dms');
    await waitFor(() => expect(where()).toHaveTextContent('/app/friends'));
  });

  it('/app/dms opens Friends when there is no conversation at all', async () => {
    world.channels = [];
    renderAt('/app/dms');
    await waitFor(() => expect(where()).toHaveTextContent('/app/friends'));
  });

  it('a landing channel that cannot be found says so and opens People rather than holding the app on a blank', async () => {
    world.landing.mockRejectedValue(new Error('the server did not answer'));
    renderAt('/app');
    await waitFor(() => expect(where()).toHaveTextContent('/app/friends'));
    expect(world.toast).toHaveBeenCalledWith('Failed to open Fuel: the server did not answer');
  });
});
