import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { botApi } from '../api/bots';
import { DeveloperPage } from './DeveloperPage';

vi.mock('../api/bots', () => ({
  botApi: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    regenerateToken: vi.fn(),
    listInstalls: vi.fn(),
  },
}));
vi.mock('../api/botStore', () => ({ botStoreApi: { getDeveloperMetrics: vi.fn() } }));
vi.mock('../api/commands', () => ({ commandApi: { listGlobalCommands: vi.fn(), deleteGlobalCommand: vi.fn() } }));
vi.mock('../stores/confirmStore', () => ({ confirm: vi.fn() }));
vi.mock('../lib/clipboard', () => ({ writeClipboardText: vi.fn() }));

const app = (id: string, name: string) => ({
  id,
  name,
  description: null,
  owner_id: 'owner-1',
  bot_user_id: `bot-${id}`,
  redirect_uri: null,
  permissions: '0',
  intents: 0,
  created_at: '2026-05-17T00:00:00Z',
  updated_at: '2026-05-17T00:00:00Z',
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/app/developers']}>
      <Routes>
        <Route path="/app/developers" element={<DeveloperPage />} />
        <Route path="/app" element={<div>Last place route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DeveloperPage as a page in main', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(botApi.list).mockResolvedValue({ data: [app('1', 'Release Helper'), app('2', 'Score Keeper')] } as never);
  });

  it('is the large title with the applications as a segmented control, New application first', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Developer portal' })).toBeInTheDocument();
    const list = screen.getByRole('tablist', { name: 'Your applications' });
    expect(await screen.findByRole('tab', { name: 'Release Helper' })).toBeInTheDocument();
    const tabs = Array.from(list.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
    expect(tabs).toEqual(['New application', 'Release Helper', 'Score Keeper']);
    expect(screen.getByRole('tab', { name: 'New application' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens an application from its segment and shows its bot as an Avatar, not a colored icon', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter initialEntries={['/app/developers']}>
        <DeveloperPage />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Score Keeper' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Score Keeper' })).toBeInTheDocument();
    expect(container.querySelector('.ix-av')?.textContent).toBe('S');
  });

  it('Escape goes back to the last place, and nothing says Home', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('tab', { name: 'Release Helper' });
    expect(screen.queryByText(/Back to home/i)).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.getByText('Last place route')).toBeInTheDocument();
  });
});
