import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsYou } from './NeedsYou';
import { usePresenceStore } from '../../../stores/presenceStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { FriendRequestEntry } from '../../../hooks/useUnifiedConversations';
import type { VoiceState } from '../../../types/index';
import type { ReactElement } from 'react';

function renderNeedsYou(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

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
  useVoiceStore.setState({ channelParticipants: new Map(), watchedStreamerId: null });
});

describe('NeedsYou', () => {
  it('renders incoming friend requests ABOVE the ranked conversation rows', () => {
    const requests = [makeRequest({ userId: 'u9', username: 'Ada', createdMs: Date.now() - 3_600_000 })];
    const entries = [makeEntry({ key: 'a:1', title: 'urgent', mentionCount: 2 })];
    const onOpenRequest = vi.fn();

    renderNeedsYou(
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
    const { rerender } = renderNeedsYou(<NeedsYou entries={[]} requests={[]} onSelect={vi.fn()} />);
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    // A lone friend request replaces the empty state with a request row.
    rerender(
      <MemoryRouter>
        <NeedsYou
          entries={[]}
          requests={[makeRequest({ userId: 'u1', username: 'Bo' })]}
          onSelect={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bo sent a friend request/ })).toBeInTheDocument();
  });

  it('signals attention entries that continue below the six-row shortlist', () => {
    renderNeedsYou(
      <NeedsYou
        entries={[makeEntry({ key: 'a:1', title: 'urgent' })]}
        overflowCount={4}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('+4 below')).toBeInTheDocument();
  });

  it('nests voice occupants under voice conversation rows', () => {
    const channelParticipants = new Map<string, VoiceState[]>([
      [
        'voice-1',
        [
          {
            user_id: 'user-2',
            session_id: 's1',
            username: 'Streamer',
            deaf: false,
            mute: false,
            self_deaf: false,
            self_mute: false,
            self_stream: true,
            self_video: false,
            suppress: false,
          },
        ],
      ],
    ]);
    useVoiceStore.setState({ channelParticipants });

    renderNeedsYou(
      <NeedsYou
        entries={[
          makeEntry({
            key: 'g1:voice-1',
            channelId: 'voice-1',
            kind: 'voice',
            title: 'Lounge',
            hasVoiceActivity: true,
          }),
        ]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: "Watch Streamer's stream" })).toBeInTheDocument();
  });
});
