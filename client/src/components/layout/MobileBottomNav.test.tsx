import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGuildStore, scopeGuild } from '../../stores/guildStore';
import { useUIStore } from '../../stores/uiStore';
import { MobileBottomNav } from './MobileBottomNav';

function LocationProbe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

function renderNav() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <MobileBottomNav />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 'user-1' } as never, token: 'token' });
  useServerListStore.setState({ activeServerId: null, servers: [] });
  useGuildStore.setState({
    guilds: [
      scopeGuild({ id: 'g1', name: 'Emerald HQ' } as never, { serverId: '__local__', userId: 'user-1' }),
      scopeGuild({ id: 'g2', name: 'Weekend Crew' } as never, { serverId: '__local__', userId: 'user-1' }),
    ] as never,
    selectedGuild: null,
  });
  useUIStore.setState({ userSettingsOpen: false });
});

describe('MobileBottomNav', () => {
  it('opens the first joined building Rooms home when no building was explicitly selected', () => {
    renderNav();

    fireEvent.click(screen.getByRole('button', { name: /^Building$/ }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1');
    expect(useGuildStore.getState().selectedGuild?.id).toBe('g1');
  });

  it('always returns to Rooms for the selected building, not an arbitrary last channel', () => {
    useGuildStore.setState({ selectedGuild: { id: 'g2', scope: { serverId: '__local__', userId: 'user-1' } } });
    renderNav();

    fireEvent.click(screen.getByRole('button', { name: /^Building$/ }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g2');
  });

  it('toggles Settings closed on a second tap', () => {
    renderNav();

    fireEvent.click(screen.getByRole('button', { name: /^Settings$/ }));
    expect(useUIStore.getState().userSettingsOpen).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /^Settings$/ }));
    expect(useUIStore.getState().userSettingsOpen).toBe(false);
  });

  it('closes Settings when navigating to another tab', () => {
    useUIStore.setState({ userSettingsOpen: true });
    renderNav();

    fireEvent.click(screen.getByRole('button', { name: /^Home$/ }));
    expect(useUIStore.getState().userSettingsOpen).toBe(false);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app');
  });
});
