import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { feedsApi, type Feed } from '../../api/feeds';
import { FeedsSection } from './FeedsSection';

vi.mock('../../api/feeds', async () => {
  const actual = await vi.importActual<typeof import('../../api/feeds')>('../../api/feeds');
  return {
    ...actual,
    feedsApi: { list: vi.fn(), setEnabled: vi.fn(), preview: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), postLatest: vi.fn() },
  };
});

vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../hooks/useChannels', () => ({
  useGuildChannels: () => [
    { id: 'c1', type: 0, name: 'general', position: 0, nsfw: false },
    { id: 'c2', type: 2, name: 'Lounge', position: 1, nsfw: false },
    { id: 'c3', type: 5, name: 'news', position: 2, nsfw: false },
  ],
}));

function feed(over: Partial<Feed> = {}): Feed {
  return {
    id: 'f1',
    guild_id: 'g1',
    channel_id: 'c3',
    kind: 'youtube',
    name: 'Lantern Works',
    icon_url: null,
    site_url: 'https://www.youtube.com/channel/UCx',
    source_title: 'Lantern Works',
    source: 'https://www.youtube.com/channel/UCx',
    api_key_set: false,
    show_on_front_page: true,
    paused: false,
    creator_id: 'u1',
    created_at: '2026-09-24T10:00:00Z',
    status: {
      last_checked_at: new Date(Date.now() - 4 * 60_000).toISOString(),
      last_success_at: null,
      next_check_at: null,
      last_posted_at: null,
      error: null,
    },
    ...over,
  };
}

describe('FeedsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(feedsApi.list).mockResolvedValue({
      data: {
        enabled: true,
        limit: 20,
        twitch_available: false,
        feeds: [
          feed(),
          feed({
            id: 'f2', kind: 'rss', name: 'Old Blog', channel_id: 'c1',
            status: { last_checked_at: null, last_success_at: null, next_check_at: null, last_posted_at: null, error: 'The feed address returned 404.' },
          }),
        ],
      },
    } as never);
  });

  it('lists feeds with their channel and how the last check went', async () => {
    render(<FeedsSection guildId="g1" />);
    expect(await screen.findByText('Lantern Works')).toBeInTheDocument();
    expect(screen.getByText(/#news · YouTube/)).toBeInTheDocument();
    expect(screen.getByText('Checked 4 min ago')).toBeInTheDocument();
    expect(screen.getByText('The feed address returned 404.')).toBeInTheDocument();
    expect(screen.getByText('2 of 20')).toBeInTheDocument();
  });

  it('adds a feed after showing what the source holds, then offers to post the newest', async () => {
    vi.mocked(feedsApi.preview).mockResolvedValue({
      data: {
        kind: 'rss', name: 'Lantern Journal', title: 'Lantern Journal', icon_url: null, site_url: null,
        source: 'https://blog.example/feed.xml', item_count: 25,
        newest: { title: 'Hello again', link: null, published_at: null, thumbnail_url: null },
      },
    } as never);
    vi.mocked(feedsApi.create).mockResolvedValue({
      data: {
        feed: feed({ id: 'f3', kind: 'rss', name: 'Lantern Journal', channel_id: 'c1' }),
        newest: { title: 'Hello again', link: null, published_at: null, thumbnail_url: null },
      },
    } as never);
    vi.mocked(feedsApi.postLatest).mockResolvedValue({ data: { message_id: 'm1' } } as never);
    const user = userEvent.setup();
    render(<FeedsSection guildId="g1" />);
    await user.click(await screen.findByRole('button', { name: 'Add a feed' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /RSS or Atom/ }));
    await user.type(within(dialog).getByRole('textbox'), 'https://blog.example/feed.xml');
    expect(await within(dialog).findByText('Checking…')).toBeInTheDocument();
    expect(await within(dialog).findByText('Lantern Journal', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(dialog).getByText(', 25 items')).toBeInTheDocument();
    // Only text and announcement channels are offered.
    const select = within(dialog).getByRole('combobox');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['#general', '#news']);
    await user.click(within(dialog).getByRole('button', { name: 'Add feed' }));
    expect(feedsApi.create).toHaveBeenCalledWith('g1', {
      source: { kind: 'rss', input: 'https://blog.example/feed.xml' },
      channel_id: 'c1',
      name: undefined,
      show_on_front_page: true,
    });
    expect(await within(dialog).findByText('Connected')).toBeInTheDocument();
    expect(within(dialog).getByText('Hello again')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Post it now' }));
    await waitFor(() => expect(feedsApi.postLatest).toHaveBeenCalledWith('g1', 'f3'));
  });

  it('shows Twitch as unavailable until the instance admin adds credentials', async () => {
    const user = userEvent.setup();
    render(<FeedsSection guildId="g1" />);
    await user.click(await screen.findByRole('button', { name: 'Add a feed' }));
    const dialog = await screen.findByRole('dialog');
    const twitch = within(dialog).getByRole('button', { name: /Twitch channel/ });
    expect(twitch).toBeDisabled();
    expect(twitch).toHaveTextContent('Your instance admin needs to add Twitch credentials first.');
  });

  it('names an obviously wrong repository before asking the server', async () => {
    const user = userEvent.setup();
    render(<FeedsSection guildId="g1" />);
    await user.click(await screen.findByRole('button', { name: 'Add a feed' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /GitHub repository/ }));
    await user.type(within(dialog).getAllByRole('textbox')[0], 'not a repo');
    expect(within(dialog).getByText('Type the repository as owner/repo.')).toBeInTheDocument();
    expect(feedsApi.preview).not.toHaveBeenCalled();
  });
});
