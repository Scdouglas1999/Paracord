import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RecentList } from './RecentList';
import { usePresenceStore } from '../../../stores/presenceStore';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';

function makeEntry(over: Partial<ConversationEntry> & { key: string }): ConversationEntry {
  return {
    serverId: 'srv',
    channelId: over.key.split(':')[1] ?? '0',
    guildId: 'g1',
    userId: null,
    kind: 'guild_text',
    title: 'channel',
    contextLabel: null,
    lastActivityId: null,
    unread: false,
    mentionCount: 0,
    isDMUnread: false,
    isThreadReply: false,
    hasVoiceActivity: false,
    pinned: false,
    ...over,
  };
}

beforeEach(() => {
  usePresenceStore.setState({ presences: new Map(), presenceOrder: new Map() });
});

describe('RecentList', () => {
  it('renders a heterogeneous merged list — channel, DM, group DM, thread', () => {
    const entries: ConversationEntry[] = [
      makeEntry({ key: 'a:1', kind: 'guild_text', title: 'general', contextLabel: 'Emerald HQ' }),
      makeEntry({ key: 'b:2', kind: 'dm', guildId: null, userId: 'u2', title: 'Wren' }),
      makeEntry({ key: 'a:3', kind: 'group_dm', guildId: null, title: 'Weekend Crew' }),
      makeEntry({ key: 'a:4', kind: 'thread', title: 'release-planning' }),
      makeEntry({ key: 'a:5', kind: 'voice', title: 'Lounge', hasVoiceActivity: true }),
    ];
    render(<MemoryRouter><RecentList entries={entries} onSelect={vi.fn()} /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    // Every heterogeneous row is present.
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('Emerald HQ')).toBeInTheDocument(); // guild context label
    expect(screen.getByText('Wren')).toBeInTheDocument();
    expect(screen.getByText('Weekend Crew')).toBeInTheDocument();
    expect(screen.getByText('release-planning')).toBeInTheDocument();
    expect(screen.getByText('Lounge')).toBeInTheDocument();
    // The voice row surfaces its live indicator; the DM row a presence dot.
    expect(screen.getByTestId('voice-live-indicator')).toBeInTheDocument();
    expect(screen.getAllByTestId('presence-dot')).toHaveLength(1);
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  it('marks the active entry and routes clicks with the entry', () => {
    const onSelect = vi.fn();
    const entries = [
      makeEntry({ key: 'a:1', title: 'general' }),
      makeEntry({ key: 'a:2', title: 'random' }),
    ];
    render(<MemoryRouter><RecentList entries={entries} activeKey="a:2" onSelect={onSelect} /></MemoryRouter>);

    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveAttribute('aria-selected', 'false');
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith(entries[0]);
  });

  it('assigns flat roving-tabindex ordinals from navIndexStart', () => {
    const entries = [makeEntry({ key: 'a:1' }), makeEntry({ key: 'a:2' })];
    render(<MemoryRouter><RecentList entries={entries} onSelect={vi.fn()} navIndexStart={10} /></MemoryRouter>);
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveAttribute('data-nav-index', '10');
    expect(rows[1]).toHaveAttribute('data-nav-index', '11');
  });

  it('renders a warm, specific empty state (not a placeholder) with discovery actions', () => {
    const onAddFriend = vi.fn();
    const onExploreServers = vi.fn();
    render(
      <MemoryRouter><RecentList
          entries={[]}
          onSelect={vi.fn()}
          onAddFriend={onAddFriend}
          onExploreServers={onExploreServers}
        /></MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.getByText('Conversations you visit will gather here.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    // Kill-list #11: no lazy placeholder copy.
    expect(screen.queryByText(/it's quiet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();

    // Two quiet inline actions wired to the friends / discovery destinations.
    fireEvent.click(screen.getByRole('button', { name: 'Add a friend' }));
    expect(onAddFriend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Explore spaces' }));
    expect(onExploreServers).toHaveBeenCalledTimes(1);
  });

  it('expands in place only when the sidebar is hiding recent rows', () => {
    const onToggleExpanded = vi.fn();
    const entries = [makeEntry({ key: 'a:1' }), makeEntry({ key: 'a:2' })];
    const { rerender } = render(
      <MemoryRouter>
        <RecentList
          entries={entries}
          totalCount={5}
          onSelect={vi.fn()}
          onToggleExpanded={onToggleExpanded}
        />
      </MemoryRouter>,
    );

    const showMore = screen.getByRole('button', { name: 'Show 3 more' });
    expect(showMore).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(showMore);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <RecentList
          entries={[...entries, makeEntry({ key: 'a:3' }), makeEntry({ key: 'a:4' }), makeEntry({ key: 'a:5' })]}
          totalCount={5}
          expanded
          onSelect={vi.fn()}
          onToggleExpanded={onToggleExpanded}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
