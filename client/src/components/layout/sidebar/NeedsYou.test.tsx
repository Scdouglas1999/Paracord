import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsYou } from './NeedsYou';
import { usePresenceStore } from '../../../stores/presenceStore';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { FriendRequestEntry } from '../../../hooks/useUnifiedConversations';

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

function makeRequest(over: Partial<FriendRequestEntry> & { userId: string }): FriendRequestEntry {
  return { key: `request:${over.userId}`, username: 'friend', createdMs: null, ...over };
}

beforeEach(() => {
  usePresenceStore.setState({ presences: new Map(), presenceOrder: new Map() });
});

describe('NeedsYou', () => {
  it('renders incoming friend requests ABOVE the ranked conversation rows', () => {
    const requests = [makeRequest({ userId: 'u9', username: 'Ada', createdMs: Date.now() - 3_600_000 })];
    const entries = [makeEntry({ key: 'a:1', title: 'urgent', mentionCount: 2 })];
    const onOpenRequest = vi.fn();

    render(
      <NeedsYou
        entries={entries}
        requests={requests}
        onOpenRequest={onOpenRequest}
        onSelect={vi.fn()}
        navIndexStart={3}
      />,
    );

    const rows = screen.getAllByRole('option');
    // Request row first (nav-index 3), then the conversation row (nav-index 4).
    expect(rows[0]).toHaveTextContent('Ada');
    expect(rows[0]).toHaveTextContent('sent a friend request');
    expect(rows[0]).toHaveAttribute('data-nav-index', '3');
    expect(rows[1]).toHaveTextContent('urgent');
    expect(rows[1]).toHaveAttribute('data-nav-index', '4');
    // A decodable timestamp renders a compact relative label.
    expect(rows[0]).toHaveTextContent('1h');

    fireEvent.click(rows[0]);
    expect(onOpenRequest).toHaveBeenCalledWith(requests[0]);
  });

  it('keeps the empty state only when there are neither requests nor conversations', () => {
    const { rerender } = render(<NeedsYou entries={[]} requests={[]} onSelect={vi.fn()} />);
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    // A lone friend request replaces the empty state with a request row.
    rerender(
      <NeedsYou
        entries={[]}
        requests={[makeRequest({ userId: 'u1', username: 'Bo' })]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bo sent a friend request/ })).toBeInTheDocument();
  });
});
