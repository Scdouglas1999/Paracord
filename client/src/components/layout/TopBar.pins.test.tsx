import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
import type { Message } from '../../types';
import { TopBar } from './TopBar';

vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...props}>
            {children}
          </div>
        ),
      ),
    },
  };
});

const mockUIState = vi.hoisted(() => ({
  toggleMemberPanel: vi.fn(),
  toggleEconomyPanel: vi.fn(),
  sidebarOpen: true,
  toggleSidebar: vi.fn(),
  setSidebarCollapsed: vi.fn(),
  memberPanelOpen: true,
  economyPanelOpen: false,
  setCommandPaletteOpen: vi.fn(),
  toggleSearchPanel: vi.fn(),
  searchPanelOpen: false,
  connectionStatus: 'connected',
  connectionLatency: 42,
}));

const mockVoiceState = vi.hoisted(() => ({
  systemAudioCaptureActive: false,
}));

const mockMessageActions = vi.hoisted(() => ({
  unpinMessage: vi.fn(),
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: typeof mockUIState) => unknown) => selector(mockUIState),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: { channelsByGuild: Record<string, unknown[]> }) => unknown) =>
    selector({ channelsByGuild: {} }),
}));

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: Object.assign(
    (selector: (state: typeof mockVoiceState) => unknown) => selector(mockVoiceState),
    { getState: () => mockVoiceState },
  ),
}));

vi.mock('../../stores/messageStore', () => ({
  useMessageStore: (selector: (state: typeof mockMessageActions) => unknown) => selector(mockMessageActions),
}));

vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({
    connected: false,
    channelId: null,
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
  }),
}));

vi.mock('../../hooks/useMobile', () => ({
  useMobile: () => false,
}));

vi.mock('../../api/auth', () => ({
  authApi: {
    getReadStates: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    getPins: vi.fn(),
    summarizeChannel: vi.fn(),
    getFollowers: vi.fn(),
    addFollower: vi.fn(),
    removeFollower: vi.fn(),
  },
}));

const pinnedMessage: Message = {
  id: 'msg-1',
  channel_id: 'channel-1',
  author: {
    id: 'user-1',
    username: 'Ada',
    discriminator: '0001',
  },
  content: 'Pinned post',
  timestamp: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  tts: false,
  mention_everyone: false,
  pinned: true,
  type: 0,
  attachments: [],
  reactions: [],
};

function renderChannelTopBar() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/channels/channel-1']}>
      <Routes>
        <Route
          path="/app/guilds/:guildId/channels/:channelId"
          element={<TopBar channelName="general" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TopBar pinned messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(channelApi.getPins).mockResolvedValue({ data: [] } as never);
    mockMessageActions.unpinMessage.mockResolvedValue(undefined);
  });

  it('shows an inline alert when pinned messages fail to load', async () => {
    vi.mocked(channelApi.getPins).mockRejectedValue(new Error('Pins endpoint unavailable.'));
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Pinned Messages' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load pinned messages: Pins endpoint unavailable.',
    );
    expect(screen.queryByText('No pinned messages yet')).not.toBeInTheDocument();
  });

  it('shows an inline alert when unpinning a message fails', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.getPins).mockResolvedValue({ data: [pinnedMessage] } as never);
    mockMessageActions.unpinMessage.mockRejectedValue(new Error('Pin permission required.'));
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Pinned Messages' }));
    await screen.findByText('Pinned post');
    await user.click(screen.getByRole('button', { name: 'Unpin this message' }));

    await waitFor(() => {
      expect(mockMessageActions.unpinMessage).toHaveBeenCalledWith('channel-1', 'msg-1');
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to unpin message: Pin permission required.',
    );
    expect(screen.getByText('Pinned post')).toBeInTheDocument();
  });

  it('does not render unsafe pinned author avatar URLs', async () => {
    vi.mocked(channelApi.getPins).mockResolvedValue({
      data: [
        {
          ...pinnedMessage,
          author: {
            ...pinnedMessage.author,
            avatar: 'javascript:alert(1)',
          },
        },
      ],
    } as never);
    const { container } = renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Pinned Messages' }));
    await screen.findByText('Pinned post');

    expect(container.querySelector('img[src="javascript:alert(1)"]')).toBeNull();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('does not render external pinned author avatar URLs', async () => {
    vi.mocked(channelApi.getPins).mockResolvedValue({
      data: [
        {
          ...pinnedMessage,
          author: {
            ...pinnedMessage.author,
            avatar: 'https://evil.example/avatar.png',
          },
        },
      ],
    } as never);
    const { container } = renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Pinned Messages' }));
    await screen.findByText('Pinned post');

    expect(container.querySelector('img[src="https://evil.example/avatar.png"]')).toBeNull();
    expect(screen.getByText('A')).toBeInTheDocument();
  });
});
