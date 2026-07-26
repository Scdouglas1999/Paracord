import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnifiedSidebar } from './UnifiedSidebar';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { UnifiedConversations, FriendRequestEntry } from '../../../hooks/useUnifiedConversations';

// MiniVoiceBar pulls in livekit-client + the full voice pipeline; stub it so the
// CallDock behaviour (renders only when connected) can be asserted in isolation.
vi.mock('../../voice/MiniVoiceBar', () => ({
  MiniVoiceBar: () => <div data-testid="mini-voice-bar" />,
}));

// The create/join-server modal is heavy (fetches templates on mount); stub it so the
// "Add a space" affordance can be asserted to OPEN it without its side effects.
vi.mock('../../guild/CreateGuildModal', () => ({
  CreateGuildModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="create-guild-modal">
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

vi.mock('../../../hooks/useUnifiedConversations', () => ({
  useUnifiedConversations: vi.fn(),
}));

function entry(over: Partial<ConversationEntry> & { key: string }): ConversationEntry {
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

function request(over: Partial<FriendRequestEntry> & { userId: string }): FriendRequestEntry {
  return { key: `request:${over.userId}`, username: 'friend', createdMs: null, ...over };
}

function conversations(over: Partial<UnifiedConversations> = {}): UnifiedConversations {
  return {
    needsYou: [entry({ key: 'srv:1', title: 'urgent-channel', mentionCount: 3 })],
    needsYouOverflowCount: 0,
    pinned: [entry({ key: 'srv:2', title: 'pinned-channel', pinned: true })],
    recent: [entry({ key: 'srv:3', title: 'lounge-channel' })],
    spaces: [
      { id: 'g1', name: 'Emerald HQ', icon: null, serverId: 'srv' },
      { id: 'g2', name: 'Side Space', icon: null, serverId: 'srv' },
    ],
    requests: [],
    ...over,
  };
}

const mockedHook = vi.mocked(useUnifiedConversations);

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderSidebar(initialPath = '/app') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <UnifiedSidebar />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockedHook.mockReturnValue(conversations());
  usePresenceStore.setState({ presences: new Map(), presenceOrder: new Map() });
  useAuthStore.setState({ user: { id: 'u1', username: 'Wren', flags: 0 } as never });
  useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 300 });
  useVoiceStore.setState({ connected: false });
});

describe('UnifiedSidebar', () => {
  it('renders the search entry and every conversation section from the unified hook', () => {
    renderSidebar();

    expect(screen.getByRole('complementary', { name: 'Navigation' })).toHaveClass(
      'w-[88vw]',
      'md:w-[min(var(--preferred-sidebar-width),32vw)]',
    );
    expect(screen.getByRole('button', { name: /open command palette/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pinned' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Spaces' })).toBeInTheDocument();

    expect(screen.getByText('urgent-channel')).toBeInTheDocument();
    expect(screen.getByText('pinned-channel')).toBeInTheDocument();
    expect(screen.getByText('lounge-channel')).toBeInTheDocument();
    expect(screen.getByText('Emerald HQ')).toBeInTheDocument();
  });

  it('renders the three fixed anchor rows above the ranked sections', () => {
    renderSidebar();
    const home = screen.getByRole('option', { name: /^Home$/ });
    const friends = screen.getByRole('option', { name: /^Friends$/ });
    const messages = screen.getByRole('option', { name: /^Messages$/ });
    // Anchors take the first three flat roving ordinals.
    expect(home).toHaveAttribute('data-nav-index', '0');
    expect(friends).toHaveAttribute('data-nav-index', '1');
    expect(messages).toHaveAttribute('data-nav-index', '2');
    // No friend requests → no badge on Friends.
    expect(screen.queryByTestId('anchor-badge-friends')).not.toBeInTheDocument();
  });

  it('marks the anchor whose route is active', () => {
    renderSidebar('/app/friends');
    expect(screen.getByRole('option', { name: /^Friends$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /^Home$/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('navigates when an anchor is clicked', () => {
    renderSidebar('/app');
    fireEvent.click(screen.getByRole('option', { name: /^Messages$/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/dms');
  });

  it('shows an emerald request badge on Friends and a request row in Needs-you', () => {
    mockedHook.mockReturnValue(
      conversations({
        requests: [
          request({ userId: 'a', username: 'Ada' }),
          request({ userId: 'b', username: 'Bo' }),
        ],
      }),
    );
    renderSidebar();

    expect(screen.getByTestId('anchor-badge-friends')).toHaveTextContent('2');
    // A request row surfaces in Needs-you and routes to the friends surface on click.
    const row = screen.getByRole('option', { name: /Ada sent a friend request/ });
    expect(row).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/friends');
  });

  it('renders a persistent "Add a space" row that opens the create-guild modal', () => {
    renderSidebar();
    expect(screen.queryByTestId('create-guild-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Add a space' }));
    expect(screen.getByTestId('create-guild-modal')).toBeInTheDocument();
  });

  it('renders UserPanel in the footer', () => {
    renderSidebar();
    // UserPanel exposes the status/menu control + settings control.
    expect(screen.getByRole('button', { name: /change status/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open user settings/i })).toBeInTheDocument();
  });

  it('shows the CallDock only when voice is connected', () => {
    const { rerender } = renderSidebar();
    expect(screen.queryByTestId('call-dock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mini-voice-bar')).not.toBeInTheDocument();

    act(() => {
      useVoiceStore.setState({ connected: true });
    });
    rerender(
      <MemoryRouter>
        <UnifiedSidebar />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('call-dock')).toBeInTheDocument();
    expect(screen.getByTestId('mini-voice-bar')).toBeInTheDocument();
  });

  it('assigns flat roving-tabindex ordinals across sections (Anchors → Needs-you → Pinned → Recent → Spaces → Add a space)', () => {
    renderSidebar();
    const rows = screen.getAllByRole('option');
    const indices = rows.map((r) => r.getAttribute('data-nav-index'));
    // 3 anchors + 1 needsYou + 1 pinned + 1 recent + 2 spaces + 1 add-a-space, contiguous.
    expect(indices).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('caps Recent at five rows by default and expands the list in place', () => {
    const recent = Array.from({ length: 11 }, (_, i) =>
      entry({ key: `srv:r${i}`, title: `recent-${i}` }),
    );
    mockedHook.mockReturnValue(conversations({ recent }));
    renderSidebar();

    expect(screen.getAllByRole('option', { name: /recent-/ })).toHaveLength(5);
    expect(screen.getByRole('heading', { name: 'Spaces' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 6 more' }));
    expect(screen.getAllByRole('option', { name: /recent-/ })).toHaveLength(11);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  });

  it('collapses to the 64px icon rail with anchors, space avatars and a mini CallDock', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    useVoiceStore.setState({ connected: true });
    renderSidebar();

    const rail = screen.getByRole('complementary', { name: 'Navigation' });
    expect(rail).toHaveAttribute('data-collapsed', 'true');

    // Full list sections are gone; anchors + space avatars + collapsed call dock remain.
    expect(screen.queryByRole('heading', { name: 'Recent' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Friends' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a space' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Emerald HQ' })).toBeInTheDocument();
    expect(screen.getByTestId('call-dock-collapsed')).toBeInTheDocument();
  });

  it('flags spaces with a live attention signal in the collapsed rail', () => {
    // needsYou entry belongs to g1 → g1 avatar shows an attention dot, g2 does not.
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();
    expect(screen.getAllByTestId('space-attention-dot')).toHaveLength(1);
  });

  it('flags the collapsed Friends anchor with a dot when requests are pending', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    mockedHook.mockReturnValue(conversations({ requests: [request({ userId: 'a' })] }));
    renderSidebar();
    expect(screen.getByTestId('anchor-attention-dot')).toBeInTheDocument();
  });
});
