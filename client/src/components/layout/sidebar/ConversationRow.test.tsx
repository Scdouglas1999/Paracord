import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationRow } from './ConversationRow';
import { usePresenceStore } from '../../../stores/presenceStore';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';

function makeEntry(over: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    key: 'srv:100',
    serverId: 'srv',
    channelId: '100',
    guildId: 'g1',
    userId: null,
    kind: 'guild_text',
    title: 'general',
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

describe('ConversationRow leading element by kind', () => {
  it('renders a Hash icon + context label for a guild_text row', () => {
    render(
      <ConversationRow
        entry={makeEntry({ kind: 'guild_text', title: 'general', contextLabel: 'Emerald HQ' })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('Emerald HQ')).toBeInTheDocument();
    // No presence dot / avatar for channel rows.
    expect(screen.queryByTestId('presence-dot')).not.toBeInTheDocument();
  });

  it('renders a presence dot + avatar for a dm row, reading presence per row', () => {
    usePresenceStore.getState().updatePresence(
      { user_id: 'u9', status: 'online', activities: [] },
      'srv',
    );
    render(
      <ConversationRow
        entry={makeEntry({ kind: 'dm', guildId: null, userId: 'u9', title: 'Wren', serverId: 'srv' })}
        onClick={vi.fn()}
      />,
    );
    const dot = screen.getByTestId('presence-dot');
    expect(dot).toHaveAttribute('data-status', 'online');
    // Avatar initial of the DM title.
    expect(screen.getByText('W')).toBeInTheDocument();
  });

  it('falls back to offline presence when the user has no presence entry', () => {
    render(
      <ConversationRow
        entry={makeEntry({ kind: 'dm', guildId: null, userId: 'ghost', title: 'Ghost' })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-status', 'offline');
  });

  it('renders a group avatar and no presence dot for a group_dm row', () => {
    render(
      <ConversationRow
        entry={makeEntry({ kind: 'group_dm', guildId: null, userId: null, title: 'Crew' })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('presence-dot')).not.toBeInTheDocument();
    expect(screen.getByText('Crew')).toBeInTheDocument();
  });

  it('renders a guild_home avatar (squircle) row', () => {
    render(
      <ConversationRow entry={makeEntry({ kind: 'guild_home', title: 'Emerald HQ' })} onClick={vi.fn()} />,
    );
    // Squircle avatar shows the guild initial, not a channel icon.
    expect(screen.getByText('E')).toBeInTheDocument();
    expect(screen.queryByTestId('presence-dot')).not.toBeInTheDocument();
  });
});

describe('ConversationRow state rendering', () => {
  it('marks the active row with aria-current/selected', () => {
    render(<ConversationRow entry={makeEntry()} active onClick={vi.fn()} />);
    const row = screen.getByRole('option');
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row.className).toContain('bg-accent-tint');
  });

  it('shows an unread dot (and no mention badge) for an unread row', () => {
    render(<ConversationRow entry={makeEntry({ unread: true })} onClick={vi.fn()} />);
    expect(screen.getByTestId('unread-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('mention-badge')).not.toBeInTheDocument();
  });

  it('does not show the plain unread dot on the active row', () => {
    render(<ConversationRow entry={makeEntry({ unread: true })} active onClick={vi.fn()} />);
    expect(screen.getByRole('option')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByTestId('unread-dot')).not.toBeInTheDocument();
  });

  it('shows an emerald mention badge with the count, superseding the unread dot', () => {
    render(<ConversationRow entry={makeEntry({ unread: true, mentionCount: 3 })} onClick={vi.fn()} />);
    const badge = screen.getByTestId('mention-badge');
    expect(badge).toHaveTextContent('3');
    expect(badge.className).toContain('bg-accent-primary');
    expect(badge.className).toContain('text-text-on-accent');
    expect(screen.queryByTestId('unread-dot')).not.toBeInTheDocument();
  });

  it('caps the mention badge at 99+', () => {
    render(<ConversationRow entry={makeEntry({ mentionCount: 250 })} onClick={vi.fn()} />);
    expect(screen.getByTestId('mention-badge')).toHaveTextContent('99+');
  });

  it('shows a live indicator when hasVoiceActivity', () => {
    render(<ConversationRow entry={makeEntry({ kind: 'voice', hasVoiceActivity: true })} onClick={vi.fn()} />);
    expect(screen.getByTestId('voice-live-indicator')).toBeInTheDocument();
  });

  it('forwards the roving-tabindex attribute and invokes onClick with the entry', () => {
    const onClick = vi.fn();
    const entry = makeEntry();
    render(<ConversationRow entry={entry} onClick={onClick} navIndex={4} tabIndex={0} />);
    const row = screen.getByRole('option');
    expect(row).toHaveAttribute('data-nav-index', '4');
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledWith(entry);
  });
});
