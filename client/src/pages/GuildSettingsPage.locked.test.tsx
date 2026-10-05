import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildSettingsPage } from './GuildSettingsPage';
import { useUIStore } from '../stores/uiStore';

const GUILD_ID = '310000000001000000350';

const state = vi.hoisted(() => ({ isAdmin: false, isLoading: false }));

vi.mock('../components/guild/GuildSettings', () => ({ GuildSettings: () => <p>settings</p> }));
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: state.isAdmin, isLoading: state.isLoading }),
}));
vi.mock('../hooks/useGuilds', () => ({
  useCurrentGuilds: () => [{ id: GUILD_ID, name: 'Fuel', hue: 176 }],
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/app/guilds/${GUILD_ID}/settings`]}>
      <Routes>
        <Route path="/app/guilds/:guildId/settings" element={<GuildSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.isAdmin = false;
  state.isLoading = false;
  act(() => useUIStore.getState().setGuildSettingsId(null));
});

describe('GuildSettingsPage before the settings open (docs/index-spec.md §6.7, §6.8)', () => {
  it('a locked server says so on the settings surface, in the server hue, with one cream way back', async () => {
    const { container } = renderPage();
    const surface = container.firstElementChild as HTMLElement;
    expect(surface).toHaveClass('ix-settings', 'ix-lt');
    expect(surface.style.getPropertyValue('--ix-hue')).toBe('176');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Server settings are locked' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to the server' })).toHaveClass('ix-cream');
    // No plate, no uppercase kicker, no Glass: the empty-state layout.
    expect(container.querySelector('.pc-plate, .glass-kicker')).toBeNull();
  });

  it('the way back leaves the settings', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Back to the server' }));
    expect(useUIStore.getState().guildSettingsId).toBeNull();
  });

  it('while the first answer is on its way it is the same surface with a spinner', () => {
    state.isLoading = true;
    const { container } = renderPage();
    expect(container.firstElementChild).toHaveClass('ix-settings');
    expect(screen.getByText('Checking your permissions in this server')).toBeInTheDocument();
  });

  it('a manager opens the settings', () => {
    state.isAdmin = true;
    renderPage();
    expect(screen.getByText('settings')).toBeInTheDocument();
  });
});
