import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGuildStore } from '../../stores/guildStore';
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
  useGuildStore.setState({
    guilds: [
      { id: 'g1', name: 'Emerald HQ' },
      { id: 'g2', name: 'Weekend Crew' },
    ] as never,
    selectedGuildId: null,
  });
  useUIStore.setState({ userSettingsOpen: false });
});

describe('MobileBottomNav', () => {
  it('opens the first joined space Rooms home when no space was explicitly selected', () => {
    renderNav();

    fireEvent.click(screen.getByRole('button', { name: /^Space$/ }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1');
    expect(useGuildStore.getState().selectedGuildId).toBe('g1');
  });

  it('always returns to Rooms for the selected space, not an arbitrary last channel', () => {
    useGuildStore.setState({ selectedGuildId: 'g2' });
    renderNav();

    fireEvent.click(screen.getByRole('button', { name: /^Space$/ }));

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
