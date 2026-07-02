import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
import { SearchPanel } from './SearchPanel';

const mockUIState = vi.hoisted(() => ({
  setSearchPanelOpen: vi.fn(),
}));

const mockChannelState = vi.hoisted(() => ({
  channelsByGuild: {
    guild_1: [{ id: 'channel-1', guild_id: 'guild-1', name: 'general' }],
  },
}));

const mockAuthState = vi.hoisted(() => ({
  user: { id: 'user-1', username: 'Ada' },
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    searchMessages: vi.fn(),
    getMessages: vi.fn(),
  },
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: typeof mockUIState) => unknown) =>
    selector(mockUIState),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: typeof mockChannelState) => unknown) =>
    selector(mockChannelState),
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: typeof mockAuthState) => unknown) =>
    selector(mockAuthState),
}));

function renderSearchPanel() {
  render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/channels/channel-1']}>
      <Routes>
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<SearchPanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(channelApi.searchMessages).mockResolvedValue({ data: [] } as never);
    vi.mocked(channelApi.getMessages).mockResolvedValue({ data: [] } as never);
  });

  it('exposes labeled search controls and close action', () => {
    renderSearchPanel();

    expect(screen.getByRole('textbox', { name: 'Search messages' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Author name filter' })).toBeInTheDocument();

    screen.getByRole('button', { name: 'Close search' }).click();
    expect(mockUIState.setSearchPanelOpen).toHaveBeenCalledWith(false);
  });

  it('announces search failure after server and fallback search fail', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.searchMessages).mockRejectedValue(new Error('search down'));
    vi.mocked(channelApi.getMessages).mockRejectedValue(new Error('fallback down'));

    renderSearchPanel();

    await user.type(screen.getByRole('textbox', { name: 'Search messages' }), 'release');

    await waitFor(() => {
      expect(channelApi.searchMessages).toHaveBeenCalledWith(
        'channel-1',
        'release',
        25,
        expect.any(Object),
      );
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Search is temporarily unavailable.',
    );
  });
});
