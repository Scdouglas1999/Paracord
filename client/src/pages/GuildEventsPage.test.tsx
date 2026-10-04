import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiClient } from '../api/client';
import { useToolbarStore } from '../components/ix/shell/toolbarStore';
import { GuildEventsPage } from './GuildEventsPage';

vi.mock('../api/client', () => ({
  apiClient: { delete: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn(), put: vi.fn() },
  extractApiError: vi.fn(() => 'request failed'),
}));
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: false, isOwner: false, isLoading: false }),
}));
vi.mock('../hooks/useGuilds', () => ({
  useGuild: () => ({ id: 'g1', name: 'Kestrel Robotics' }),
  useAvailableGuilds: () => [],
}));

const event = (id: string, name: string, status: number) => ({
  id, guild_id: 'g1', channel_id: null, event_channel_id: null, creator_id: 'u', name, description: null,
  scheduled_start: '2026-10-02T21:00:00.000Z', scheduled_end: null, status, entity_type: 2, location: null,
  image_url: null, user_count: 1, user_rsvp: false, created_at: '2026-10-01T00:00:00.000Z',
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/g1/events']}>
      <Routes>
        <Route path="/app/guilds/:guildId/events" element={<GuildEventsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useToolbarStore.setState({ page: null, owner: null });
});
afterEach(cleanup);

describe('GuildEventsPage', () => {
  it('is the calendar on a large-title page, and counts what is still to come in its subtitle', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [event('1', 'Soldering hour', 1), event('2', 'Retro', 2), event('3', 'Old', 3)] });
    renderPage();
    expect(await screen.findByText('Soldering hour')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Events' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Kestrel Robotics · 2 events still to come')).toBeInTheDocument());
    expect(useToolbarStore.getState().page?.title).toBe('Events');
    // The page has the title; the list does not say it again.
    expect(screen.queryByRole('heading', { level: 2, name: 'Events' })).not.toBeInTheDocument();
  });

  it('says one event, and says nothing is coming when nothing is', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [event('1', 'Soldering hour', 1)] });
    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getByText('Kestrel Robotics · 1 event still to come')).toBeInTheDocument());
    unmount();
    vi.mocked(apiClient.get).mockResolvedValue({ data: [event('3', 'Old', 3)] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Kestrel Robotics · Nothing is coming up')).toBeInTheDocument());
  });
});
