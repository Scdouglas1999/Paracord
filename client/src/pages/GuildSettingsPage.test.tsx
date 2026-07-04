import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildSettingsPage } from './GuildSettingsPage';
import { useUIStore } from '../stores/uiStore';

const GUILD_ID = 'guild-1';
const OTHER_GUILD_ID = 'guild-2';

// Navigation is asserted via a spy so we can prove the windowed overlay never
// navigates while the standalone route instance does.
const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateSpy };
});

// GuildSettings pulls in the whole settings surface; stub it down to a close button
// so the test exercises only the page-level entry/overlay plumbing.
vi.mock('../components/guild/GuildSettings', () => ({
  GuildSettings: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      close-settings
    </button>
  ),
}));

vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: true, isLoading: false }),
}));

vi.mock('../stores/guildStore', () => ({
  useGuildStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ guilds: [{ id: GUILD_ID, name: 'Test Guild' }] }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    useUIStore.getState().setGuildSettingsId(null);
  });
});

describe('GuildSettingsPage entry paths (new IA)', () => {
  it('as the windowed overlay, closing dismisses without navigating even from another route', async () => {
    const user = userEvent.setup();
    act(() => {
      // Opened from GuildHomeHeader / SpacesList for GUILD_ID.
      useUIStore.getState().setGuildSettingsId(GUILD_ID);
    });

    // Rendered outside its own route (like AppShell's overlay) while the URL points
    // at a *different* guild's channel — useParams would otherwise leak that guildId.
    render(
      <MemoryRouter initialEntries={[`/app/guilds/${OTHER_GUILD_ID}/channels/c1`]}>
        <Routes>
          <Route path="/app/guilds/:guildId/channels/:channelId" element={<GuildSettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'close-settings' }));

    expect(useUIStore.getState().guildSettingsId).toBeNull();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('as the standalone route, closing navigates back to the guild home', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={[`/app/guilds/${GUILD_ID}/settings`]}>
        <Routes>
          <Route path="/app/guilds/:guildId/settings" element={<GuildSettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'close-settings' }));

    expect(navigateSpy).toHaveBeenCalledWith(`/app/guilds/${GUILD_ID}`);
  });
});
