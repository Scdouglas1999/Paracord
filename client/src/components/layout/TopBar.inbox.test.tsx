import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../../api/auth';
import { useReadStateStore } from '../../stores/readStateStore';
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
  contextPanelMode: null as string | null,
  toggleContextPanelMode: vi.fn(),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: vi.fn(),
  setCommandPaletteOpen: vi.fn(),
  setGuildSettingsId: vi.fn(),
  connectionStatus: 'connected',
  connectionLatency: 42,
}));

const mockPermissions = vi.hoisted(() => ({
  permissions: 0n,
  isAdmin: false,
  isOwner: false,
  isLoading: false,
}));

const mockVoiceState = vi.hoisted(() => ({
  systemAudioCaptureActive: false,
}));

const mockChannelState = vi.hoisted(() => ({
  channelsByGuild: {} as Record<string, unknown[]>,
  channelsById: {} as Record<string, unknown>,
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: typeof mockUIState) => unknown) => selector(mockUIState),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => mockPermissions,
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: typeof mockChannelState) => unknown) =>
    selector(mockChannelState),
}));

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: Object.assign(
    (selector: (state: typeof mockVoiceState) => unknown) => selector(mockVoiceState),
    { getState: () => mockVoiceState },
  ),
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

function renderChannelTopBar() {
  render(
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

describe('TopBar inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelState.channelsByGuild = {};
    mockChannelState.channelsById = {};
    useReadStateStore.getState().reset();
    vi.mocked(authApi.getReadStates).mockResolvedValue({ data: [] } as never);
  });

  it('shows an inline alert when inbox unread state fails to load', async () => {
    vi.mocked(authApi.getReadStates).mockRejectedValue(new Error('Read-state service unavailable.'));
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load inbox: Read-state service unavailable.',
    );
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
  });

  it('does not list the currently open channel as unread in the inbox', async () => {
    mockChannelState.channelsByGuild = {
      'guild-1': [
        {
          id: 'channel-1',
          guild_id: 'guild-1',
          name: 'general',
          type: 0,
          channel_type: 0,
          last_message_id: '200',
        },
        {
          id: 'channel-2',
          guild_id: 'guild-1',
          name: 'random',
          type: 0,
          channel_type: 0,
          last_message_id: '300',
        },
      ],
    };
    mockChannelState.channelsById = {
      'channel-1': mockChannelState.channelsByGuild['guild-1'][0],
      'channel-2': mockChannelState.channelsByGuild['guild-1'][1],
    };
    useReadStateStore.getState().setAll([
      { channel_id: 'channel-1', last_message_id: '100', mention_count: 0 },
      { channel_id: 'channel-2', last_message_id: '100', mention_count: 0 },
    ]);

    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));

    expect(await screen.findByText('#random')).toBeInTheDocument();
    expect(screen.queryByText('#general')).not.toBeInTheDocument();
  });
});
