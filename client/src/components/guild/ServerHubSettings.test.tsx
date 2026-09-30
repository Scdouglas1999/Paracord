import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Guild } from '../../types';

vi.mock('../../api/guilds', () => ({ guildApi: { update: vi.fn() } }));
vi.mock('../../hooks/useDailyWord', () => ({ useDailyWordSettings: () => ({ enabled: false }) }));
vi.mock('../../hooks/useGameServers', () => ({ useGameServers: () => ({ enabled: false }) }));

import { ServerHubSettings } from './ServerHubSettings';

const guild: Guild = {
  id: 'g1',
  name: 'Game Night',
  owner_id: 'owner',
  member_count: 8,
  created_at: '2026-01-01T00:00:00.000Z',
};

afterEach(cleanup);

function renderSettings() {
  return render(<ServerHubSettings guild={guild} channels={[]} onUpdate={vi.fn()} setError={vi.fn()} />);
}

describe('ServerHubSettings: the widgets section', () => {
  it('names the page the widgets are on the Overview, in one column, in plain words', () => {
    const { container } = renderSettings();
    expect(screen.getByText('Overview page')).toBeInTheDocument();
    expect(
      screen.getByText(/The widgets on this server.s Overview page, top to bottom, between Live now and Latest\. One with nothing to show stays hidden\./),
    ).toBeInTheDocument();
    // The Glass Overview has no feed beside them, and nothing is called a home page any more.
    expect(container.textContent).not.toMatch(/beside the feed/i);
    expect(container.textContent).not.toMatch(/home page/i);
    expect(container.textContent).not.toMatch(/widget column/i);
  });

  it('still lists the widgets to reorder', () => {
    renderSettings();
    const list = screen.getByRole('list', { name: /widgets/i });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
