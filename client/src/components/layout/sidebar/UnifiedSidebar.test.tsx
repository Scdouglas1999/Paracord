import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnifiedSidebar } from './UnifiedSidebar';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { UnifiedConversations } from '../../../hooks/useUnifiedConversations';

// MiniVoiceBar pulls in livekit-client + the full voice pipeline; stub it so the
// CallDock behaviour (renders only when connected) can be asserted in isolation.
vi.mock('../../voice/MiniVoiceBar', () => ({
  MiniVoiceBar: () => <div data-testid="mini-voice-bar" />,
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

const CONVERSATIONS: UnifiedConversations = {
  needsYou: [entry({ key: 'srv:1', title: 'urgent-channel', mentionCount: 3 })],
  pinned: [entry({ key: 'srv:2', title: 'pinned-channel', pinned: true })],
  recent: [entry({ key: 'srv:3', title: 'lounge-channel' })],
  spaces: [
    { id: 'g1', name: 'Emerald HQ', icon: null, serverId: 'srv' },
    { id: 'g2', name: 'Side Space', icon: null, serverId: 'srv' },
  ],
};

const mockedHook = vi.mocked(useUnifiedConversations);

function renderSidebar() {
  return render(
    <MemoryRouter>
      <UnifiedSidebar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockedHook.mockReturnValue(CONVERSATIONS);
  usePresenceStore.setState({ presences: new Map(), presenceOrder: new Map() });
  useAuthStore.setState({ user: { id: 'u1', username: 'Wren', flags: 0 } as never });
  useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 300 });
  useVoiceStore.setState({ connected: false });
});

describe('UnifiedSidebar', () => {
  it('renders the search entry and every conversation section from the unified hook', () => {
    renderSidebar();

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

  it('renders UserPanel in the footer', () => {
    renderSidebar();
    // UserPanel exposes the username-copy button + settings control.
    expect(screen.getByRole('button', { name: /copy username wren/i })).toBeInTheDocument();
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

  it('assigns flat roving-tabindex ordinals across sections (Needs-you → Pinned → Recent → Spaces)', () => {
    renderSidebar();
    const rows = screen.getAllByRole('option');
    const indices = rows.map((r) => r.getAttribute('data-nav-index'));
    // 1 needsYou + 1 pinned + 1 recent + 2 spaces, contiguous from 0.
    expect(indices).toEqual(['0', '1', '2', '3', '4']);
  });

  it('collapses to the 64px icon rail with space avatars and a mini CallDock', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    useVoiceStore.setState({ connected: true });
    renderSidebar();

    const rail = screen.getByRole('complementary', { name: 'Navigation' });
    expect(rail).toHaveAttribute('data-collapsed', 'true');

    // Full list sections are gone; space avatars + collapsed call dock remain.
    expect(screen.queryByRole('heading', { name: 'Recent' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Emerald HQ' })).toBeInTheDocument();
    expect(screen.getByTestId('call-dock-collapsed')).toBeInTheDocument();
  });

  it('flags spaces with a live attention signal in the collapsed rail', () => {
    // needsYou entry belongs to g1 → g1 avatar shows an attention dot, g2 does not.
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();
    expect(screen.getAllByTestId('space-attention-dot')).toHaveLength(1);
  });
});
