import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGoToPlace } from './usePlaceNavigation';

const mocks = vi.hoisted(() => ({
  landing: vi.fn(),
  toast: vi.fn(),
  guilds: [] as unknown[],
}));
const DEFAULT_GUILDS = [
  { id: 'fuel', name: 'Fuel', scope: { serverId: '__local__', userId: 'me' } },
  { id: 'game', name: 'Game Night', scope: { serverId: '__local__', userId: 'me' } },
];

vi.mock('../../../lib/guildNavigation', () => ({ guildLandingPath: mocks.landing }));
vi.mock('../../../stores/toastStore', () => ({ toast: { error: mocks.toast } }));
vi.mock('../../../api/client', () => ({ extractApiError: (error: Error) => error.message }));
vi.mock('../../../hooks/useGuilds', () => ({ useAvailableGuilds: () => mocks.guilds }));

let here = '';

/** Run the navigation inside act, so the router's re-render has landed when it returns. */
const go = (navigate: (key: string) => Promise<void>, key: string) => act(() => navigate(key));

function Where() {
  const { pathname } = useLocation();
  useEffect(() => {
    here = pathname;
  });
  return null;
}

function setup(path: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>
      <Where />
      {children}
    </MemoryRouter>
  );
  return renderHook(() => useGoToPlace(), { wrapper });
}

beforeEach(() => {
  mocks.guilds = DEFAULT_GUILDS;
  mocks.landing.mockReset();
  mocks.toast.mockReset();
  mocks.landing.mockImplementation(async (guild: { id: string }) => `/app/guilds/${guild.id}/channels/general`);
});

describe('useGoToPlace with two servers that minted the same id', () => {
  it('goes to the server the key names, not the first with that id', async () => {
    mocks.guilds = [
      { id: 'twin', name: 'Cedar place', scope: { serverId: '__local__', userId: 'me' } },
      { id: 'twin', name: 'Lantern place', scope: { serverId: 's_lantern', userId: 'me2' } },
    ];
    const lantern = setup('/app/guilds/fuel/channels/c1');
    await go(lantern.result.current, 'twin@s_lantern');
    expect(mocks.landing).toHaveBeenCalledWith(expect.objectContaining({ name: 'Lantern place' }));
    mocks.landing.mockClear();
    const cedar = setup('/app/guilds/fuel/channels/c1');
    await go(cedar.result.current, 'twin');
    expect(mocks.landing).toHaveBeenCalledWith(expect.objectContaining({ name: 'Cedar place' }));
  });
});

describe('useGoToPlace', () => {
  it('goes to a server\'s landing channel', async () => {
    const { result } = setup('/app/guilds/fuel/channels/c1');
    await go(result.current, 'game');
    expect(here).toBe('/app/guilds/game/channels/general');
    expect(mocks.landing).toHaveBeenCalledWith(expect.objectContaining({ id: 'game' }));
  });

  it('goes to People at /app/dms', async () => {
    const { result } = setup('/app/guilds/fuel/channels/c1');
    await go(result.current, 'people');
    expect(here).toBe('/app/dms');
  });

  it('does nothing for the place you are in a conversation of', async () => {
    const { result } = setup('/app/guilds/fuel/channels/c1');
    await go(result.current, 'fuel');
    expect(mocks.landing).not.toHaveBeenCalled();
    expect(here).toBe('/app/guilds/fuel/channels/c1');

    const people = setup('/app/dms/77');
    await go(people.result.current, 'people');
    expect(here).toBe('/app/dms/77');
    const friends = setup('/app/friends');
    await go(friends.result.current, 'people');
    expect(here).toBe('/app/friends');
  });

  it('takes you to a channel from one of its other pages', async () => {
    const { result } = setup('/app/guilds/fuel/settings');
    await go(result.current, 'fuel');
    expect(here).toBe('/app/guilds/fuel/channels/general');
  });

  it('goes to a server from a page that belongs to no place', async () => {
    const { result } = setup('/app/discovery');
    await go(result.current, 'fuel');
    expect(here).toBe('/app/guilds/fuel/channels/general');
  });

  it('ignores a server that is not in the dock', async () => {
    const { result } = setup('/app/guilds/fuel/channels/c1');
    await go(result.current, 'gone');
    expect(mocks.landing).not.toHaveBeenCalled();
    expect(here).toBe('/app/guilds/fuel/channels/c1');
  });

  it('says so, with the reason, when the server cannot be opened, and stays where it is', async () => {
    mocks.landing.mockRejectedValue(new Error('The account for this instance is no longer signed in.'));
    const { result } = setup('/app/guilds/fuel/channels/c1');
    await go(result.current, 'game');
    expect(mocks.toast).toHaveBeenCalledWith('Failed to open Game Night: The account for this instance is no longer signed in.');
    expect(here).toBe('/app/guilds/fuel/channels/c1');
  });
});
