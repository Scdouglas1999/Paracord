import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextChannelList } from './TextChannelList';
import { ChannelType, type Channel } from '../../types';

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const unreadState = {
  isChannelUnread: new Set<string>(),
  channelMentionCounts: new Map<string, number>(),
};

vi.mock('../../hooks/useUnreadCounts', () => ({
  useUnreadCounts: () => unreadState,
}));

const guildId = 'guild-1';

const category: Channel = {
  id: 'cat-1',
  type: ChannelType.Category,
  channel_type: ChannelType.Category,
  guild_id: guildId,
  name: 'Projects',
  position: 0,
  nsfw: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

function chan(over: Partial<Channel> & { id: string; name: string; type: ChannelType }): Channel {
  return {
    channel_type: over.type,
    guild_id: guildId,
    position: 1,
    nsfw: false,
    parent_id: category.id,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const general = chan({ id: 'c-general', name: 'general', type: ChannelType.Text });
const announce = chan({ id: 'c-announce', name: 'news', type: ChannelType.Announcement });
const voice = chan({ id: 'c-voice', name: 'Lounge', type: ChannelType.Voice });

const channels: Channel[] = [category, general, announce, voice];

function renderList(initialPath = `/app/guilds/${guildId}`) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TextChannelList guildId={guildId} channels={channels} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockReset();
  unreadState.isChannelUnread = new Set();
  unreadState.channelMentionCounts = new Map();
});

describe('TextChannelList', () => {
  it('groups text/announcement channels under their category and filters voice out', () => {
    renderList();

    expect(screen.getByRole('group', { name: 'Projects channels' })).toBeInTheDocument();
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('news')).toBeInTheDocument();
    // Voice/stage channels are the Rooms grid's job, never the text list.
    expect(screen.queryByText('Lounge')).not.toBeInTheDocument();
  });

  it('navigates to the channel route on click', () => {
    renderList();

    fireEvent.click(screen.getByRole('button', { name: /general/ }));

    expect(navigate).toHaveBeenCalledWith(`/app/guilds/${guildId}/channels/c-general`);
  });

  it('marks the routed channel active and never as unread', () => {
    unreadState.isChannelUnread = new Set(['c-general']);
    renderList(`/app/guilds/${guildId}/channels/c-general`);

    const active = screen.getByRole('button', { name: /general/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    // Active channel suppresses its own unread dot.
    expect(active.querySelector('[aria-current]')).toBeNull();
  });

  it('shows an unread dot for unread, non-active channels', () => {
    unreadState.isChannelUnread = new Set(['c-general']);
    renderList();

    const row = screen.getByRole('button', { name: /general/ });
    // 8px emerald unread dot (design-spec §7 nav-item recipe).
    expect(row.querySelector('.bg-accent-primary')).not.toBeNull();
  });

  it('renders an emerald mention badge with the count', () => {
    unreadState.channelMentionCounts = new Map([['c-general', 3]]);
    renderList();

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders a warm, left-aligned empty state when there are no text channels', () => {
    render(
      <MemoryRouter initialEntries={[`/app/guilds/${guildId}`]}>
        <TextChannelList guildId={guildId} channels={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByText('No text channels yet')).toBeInTheDocument();
    // Kill-list #11: specific copy, not a lazy placeholder.
    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
