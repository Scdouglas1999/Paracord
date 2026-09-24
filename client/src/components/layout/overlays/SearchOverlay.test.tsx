import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guildApi } from '../../../api/guilds';
import { SearchOverlay } from './SearchOverlay';

vi.mock('../../../api/guilds', () => ({
  guildApi: {
    searchMessages: vi.fn(),
  },
  createGuildApi: vi.fn(),
}));

const message = {
  id: 'm1',
  channel_id: 'channel-1',
  author: { id: 'u1', username: 'yara', discriminator: '0', display_name: 'Yara' },
  content: 'postgres notes',
  created_at: '2026-09-01T15:00:00Z',
  tts: false,
  mention_everyone: false,
  pinned: false,
  type: 0,
  attachments: [],
  reactions: [],
};

function renderSearchOverlay(onClose = vi.fn(), props: { guildId?: string | null } = { guildId: 'guild-1' }) {
  render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/channels/channel-1']}>
      <SearchOverlay
        open
        onClose={onClose}
        guildId={props.guildId}
        channelId="channel-1"
        channelName="general"
      />
    </MemoryRouter>,
  );
  return { onClose };
}

describe('SearchOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(guildApi.searchMessages).mockResolvedValue({ data: { total: 0, messages: [] } } as never);
  });

  it('opens as a named panel with a labeled search field, the server scope and close action', async () => {
    const { onClose } = renderSearchOverlay();

    expect(screen.getByRole('complementary', { name: 'Search messages' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Search messages' })).toBeInTheDocument();
    expect(screen.getByText('This server')).toBeInTheDocument();
    expect(screen.getByText('Narrow it down')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the server error and does not scan loaded messages', async () => {
    const user = userEvent.setup();
    let rejectSearch: (error: Error) => void = () => {};
    vi.mocked(guildApi.searchMessages).mockImplementation(
      () => new Promise((_, reject) => {
        rejectSearch = reject;
      }) as never,
    );
    renderSearchOverlay();

    await user.type(screen.getByRole('combobox', { name: 'Search messages' }), 'release');

    expect(await screen.findByRole('status')).toHaveTextContent('Searching messages…');
    await waitFor(() => {
      expect(guildApi.searchMessages).toHaveBeenCalled();
    });
    await act(async () => {
      rejectSearch(new Error('Search is down'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Search is down');
    expect(guildApi.searchMessages).toHaveBeenCalledWith('guild-1', expect.objectContaining({
      q: 'release',
      limit: 25,
      offset: 0,
    }));
  });

  it('groups results from more than one channel', async () => {
    const user = userEvent.setup();
    vi.mocked(guildApi.searchMessages).mockResolvedValue({
      data: {
        total: 2,
        messages: [
          {
            message: { ...message, id: 'm1', content: 'postgres in design' },
            channel_id: 'channel-2',
            channel_name: 'design',
          },
          {
            message: { ...message, id: 'm2', content: 'postgres in general' },
            channel_id: 'channel-1',
            channel_name: 'general',
          },
        ],
      },
    } as never);
    renderSearchOverlay();

    await user.type(screen.getByRole('combobox', { name: 'Search messages' }), 'postgres');

    expect(await screen.findByRole('heading', { name: 'design' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'general' })).toBeInTheDocument();
    expect(screen.getByText('2 results')).toBeInTheDocument();
    expect(screen.getAllByText(/postgres/).length).toBeGreaterThan(0);
  });

  it('turns a typed has filter into a chip and sends it', async () => {
    const user = userEvent.setup();
    renderSearchOverlay();
    await user.type(screen.getByRole('combobox', { name: 'Search messages' }), 'has:link');
    expect(await screen.findByRole('button', { name: /Remove has:link/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(guildApi.searchMessages).toHaveBeenCalledWith('guild-1', expect.objectContaining({
        has: ['link'],
      }));
    });
  });

  it('removes the last chip with Backspace on an empty field', async () => {
    const user = userEvent.setup();
    renderSearchOverlay();
    const field = screen.getByRole('combobox', { name: 'Search messages' });
    await user.type(field, 'has:link');
    expect(await screen.findByRole('button', { name: /Remove has:link/ })).toBeInTheDocument();
    await user.keyboard('{Backspace}');
    expect(screen.queryByRole('button', { name: /Remove has:link/ })).not.toBeInTheDocument();
  });

  it('offers to drop a filter when nothing matches', async () => {
    const user = userEvent.setup();
    renderSearchOverlay();
    await user.type(screen.getByRole('combobox', { name: 'Search messages' }), 'has:poll');
    expect(await screen.findByText('No messages match this search.')).toBeInTheDocument();
    expect(screen.getByText(/Try dropping a filter/)).toBeInTheDocument();
  });

  it('jumps to the selected result with Enter and remembers the search', async () => {
    const user = userEvent.setup();
    vi.mocked(guildApi.searchMessages).mockResolvedValue({
      data: {
        total: 1,
        messages: [{ message: { ...message, id: 'm9' }, channel_id: 'channel-2', channel_name: 'design' }],
      },
    } as never);
    const { onClose } = renderSearchOverlay();
    await user.type(screen.getByRole('combobox', { name: 'Search messages' }), 'postgres');
    expect(await screen.findByText('1 result')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem('paracord:recent-searches:guild:guild-1') ?? '[]');
    expect(saved.map((entry: { label: string }) => entry.label)).toEqual(['postgres']);
  });

  it('does not open a result from the previous words while the new search is on its way', async () => {
    const user = userEvent.setup();
    vi.mocked(guildApi.searchMessages).mockResolvedValueOnce({
      data: {
        total: 1,
        messages: [{ message: { ...message, id: 'old', content: 'postgres elsewhere' }, channel_id: 'channel-2', channel_name: 'design' }],
      },
    } as never);
    let finish: (value: unknown) => void = () => {};
    vi.mocked(guildApi.searchMessages).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }) as never,
    );
    const { onClose } = renderSearchOverlay();
    const field = screen.getByRole('combobox', { name: 'Search messages' });
    await user.type(field, 'postgres');
    expect(await screen.findByText('1 result')).toBeInTheDocument();
    await user.type(field, ' density{Enter}');
    expect(onClose).not.toHaveBeenCalled();
    // Wait for the follow-up search to actually be in flight before ending it:
    // otherwise its queued once-implementation leaks into the next test.
    await waitFor(() => {
      expect(guildApi.searchMessages).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      finish({ data: { total: 0, messages: [] } });
    });
    await user.keyboard('{Enter}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders a result snippet as plain text with mentions resolved and spoilers hidden', async () => {
    const user = userEvent.setup();
    vi.mocked(guildApi.searchMessages).mockResolvedValue({
      data: {
        total: 1,
        messages: [{
          message: {
            ...message,
            id: 'm1',
            content: 'the **postgres** plan <@777> ||secret|| `migrate`',
          },
          channel_id: 'channel-1',
          channel_name: 'general',
        }],
      },
    } as never);
    renderSearchOverlay();

    await user.type(screen.getByRole('combobox', { name: 'Search messages' }), 'postgres');

    const mark = await screen.findByText('postgres');
    const snippet = mark.parentElement!.textContent ?? '';
    expect(snippet).toBe('the postgres plan @someone spoiler migrate');
    expect(snippet).not.toContain('**');
    expect(snippet).not.toContain('`');
    expect(snippet).not.toContain('<@777>');
    expect(snippet).not.toContain('secret');
  });

  it('writes a result time the way the rest of the app does: lowercase pm', async () => {
    const user = userEvent.setup();
    vi.mocked(guildApi.searchMessages).mockResolvedValue({
      data: {
        total: 1,
        messages: [{ message, channel_id: 'channel-1', channel_name: 'general' }],
      },
    } as never);
    renderSearchOverlay();

    await user.type(screen.getByRole('combobox', { name: 'Search messages' }), 'postgres');

    const mark = await screen.findByText('postgres');
    const row = mark.closest('button')!;
    const when = row.querySelector('.tabular-nums')!;
    expect(when.textContent).toMatch(/\d{1,2}:\d{2} [ap]m/);
    expect(when.textContent).not.toMatch(/[AP]M/);
  });

  it('searches a direct conversation on this device only', async () => {
    const user = userEvent.setup();
    renderSearchOverlay(vi.fn(), { guildId: null });
    expect(screen.getByText('This conversation')).toBeInTheDocument();
    expect(screen.getByText('Searching messages loaded on this device')).toBeInTheDocument();
    expect(screen.queryByText('in:')).not.toBeInTheDocument();
    await user.type(screen.getByRole('combobox', { name: 'Search messages' }), 'postgres');
    expect(await screen.findByText('No messages match this search.')).toBeInTheDocument();
    expect(guildApi.searchMessages).not.toHaveBeenCalled();
  });
});
