import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useToolbarStore } from '../components/ix/shell/toolbarStore';
import { useDailyWordStore } from '../stores/dailyWordStore';
import { GuildDailyWordPage } from './GuildDailyWordPage';

vi.mock('../hooks/useGuilds', () => ({
  useGuild: () => ({ id: 'g1', name: 'Kestrel Robotics' }),
  useAvailableGuilds: () => [],
}));
vi.mock('../hooks/useDailyWord', () => ({
  useDailyWordSettings: () => ({
    settings: { guild_id: 'g1', enabled: true, share_channel_id: null, show_on_front_page: true, updated_at: '' },
    status: 'ready',
    error: null,
    enabled: true,
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/g1/daily-word']}>
      <Routes>
        <Route path="/app/guilds/:guildId/daily-word" element={<GuildDailyWordPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useToolbarStore.setState({ page: null, owner: null });
  useDailyWordStore.setState({
    today: {
      puzzle: 412, date: '2026-10-01', next_puzzle_at: '2099-10-02T00:00:00Z', word_length: 5, max_guesses: 6,
      guesses: [], finished: false, solved: false,
    },
    todayStatus: 'ready',
    boards: {},
    refreshToday: vi.fn(async () => {}),
    refreshBoard: vi.fn(async () => {}),
    refreshStats: vi.fn(async () => {}),
  } as never);
});
afterEach(cleanup);

describe('GuildDailyWordPage', () => {
  it('is the puzzle on a large-title page: the page is the one h1 and says the server, the puzzle keeps its own look', async () => {
    renderPage();
    expect(await screen.findByText(/No\. 412/)).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Daily word' })).toBeInTheDocument();
    expect(screen.getByText('Kestrel Robotics')).toBeInTheDocument();
    expect(useToolbarStore.getState().page?.title).toBe('Daily word');
    // The view's own plate and header are gone: its section is inside the page.
    const section = screen.getByRole('region', { name: 'Daily word' });
    expect(section).toHaveClass('ix-addon');
    expect(screen.getByRole('switch', { name: 'High contrast colors' })).toBeInTheDocument();
  });
});
