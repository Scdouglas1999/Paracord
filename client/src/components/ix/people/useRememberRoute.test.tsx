import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLACE_MEMORY_KEY } from './lastPlace';
import { useRememberRoute } from './useRememberRoute';

const world = vi.hoisted(() => ({ userId: 'me' as string | null, guilds: [{ id: 'g1', scope: { serverId: 's1' } }] as Array<{ id: string; scope: { serverId: string } }> }));
vi.mock('../../../hooks/useCurrentUser', () => ({ useCurrentUser: () => (world.userId ? { id: world.userId } : null) }));
vi.mock('../../../hooks/useGuilds', () => ({ useAvailableGuilds: () => world.guilds }));

function Probe({ enabled = true }: { enabled?: boolean }) {
  useRememberRoute(enabled);
  const navigate = useNavigate();
  return <button onClick={() => navigate('/app/dms/d1')}>go</button>;
}

const stored = () => JSON.parse(window.localStorage.getItem(PLACE_MEMORY_KEY) ?? 'null');

beforeEach(() => {
  window.localStorage.clear();
  world.userId = 'me';
  world.guilds = [{ id: 'g1', scope: { serverId: 's1' } }];
});

describe('useRememberRoute', () => {
  it('remembers the route as it changes', () => {
    render(<MemoryRouter initialEntries={['/app/guilds/g1/channels/c1']}><Probe /></MemoryRouter>);
    expect(stored()).toMatchObject({ userId: 'me', place: 'g1', path: '/app/guilds/g1/channels/c1' });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(stored()).toMatchObject({ place: 'people', people: '/app/dms/d1' });
  });

  it('remembers a server once it is in the list, not before (a stale link is not where you were)', () => {
    world.guilds = [];
    const { rerender } = render(<MemoryRouter initialEntries={['/app/guilds/g1/channels/c1']}><Probe /></MemoryRouter>);
    expect(stored()).toBeNull();
    world.guilds = [{ id: 'g1', scope: { serverId: 's1' } }];
    rerender(<MemoryRouter initialEntries={['/app/guilds/g1/channels/c1']}><Probe /></MemoryRouter>);
    expect(stored()).toMatchObject({ place: 'g1' });
  });

  it('a pane that is sliding out remembers nothing, and nobody signed in remembers nothing', () => {
    const { unmount } = render(<MemoryRouter initialEntries={['/app/dms/d1']}><Probe enabled={false} /></MemoryRouter>);
    expect(stored()).toBeNull();
    unmount();
    world.userId = null;
    render(<MemoryRouter initialEntries={['/app/dms/d1']}><Probe /></MemoryRouter>);
    expect(stored()).toBeNull();
  });
});
