import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    render(<RecentList entries={entries} onSelect={vi.fn()} />);

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
    render(<RecentList entries={entries} activeKey="a:2" onSelect={onSelect} />);

    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveAttribute('aria-selected', 'false');
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith(entries[0]);
  });

  it('assigns flat roving-tabindex ordinals from navIndexStart', () => {
    const entries = [makeEntry({ key: 'a:1' }), makeEntry({ key: 'a:2' })];
    render(<RecentList entries={entries} onSelect={vi.fn()} navIndexStart={10} />);
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveAttribute('data-nav-index', '10');
    expect(rows[1]).toHaveAttribute('data-nav-index', '11');
  });

  it('renders a warm, specific empty state (not a placeholder) with discovery actions', () => {
    const onAddFriend = vi.fn();
    const onExploreServers = vi.fn();
    render(
      <RecentList
        entries={[]}
        onSelect={vi.fn()}
        onAddFriend={onAddFriend}
        onExploreServers={onExploreServers}
      />,
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
    fireEvent.click(screen.getByRole('button', { name: 'Explore servers' }));
    expect(onExploreServers).toHaveBeenCalledTimes(1);
  });

  it('shows an "All conversations" footer link only when there are recents', () => {
    const onViewAll = vi.fn();
    const { rerender } = render(<RecentList entries={[]} onSelect={vi.fn()} onViewAll={onViewAll} />);
    // Empty → no footer.
    expect(screen.queryByRole('button', { name: /All conversations/ })).not.toBeInTheDocument();

    rerender(
      <RecentList
        entries={[makeEntry({ key: 'a:1', title: 'general' })]}
        onSelect={vi.fn()}
        onViewAll={onViewAll}
      />,
    );
    const footer = screen.getByRole('button', { name: /All conversations/ });
    fireEvent.click(footer);
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });
});
