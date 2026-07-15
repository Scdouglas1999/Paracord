import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
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

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: typeof mockUIState) => unknown) => selector(mockUIState),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => mockPermissions,
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: { channelsByGuild: Record<string, unknown[]>; channelsById: Record<string, unknown> }) => unknown) =>
    selector({ channelsByGuild: {}, channelsById: {} }),
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

describe('TopBar channel summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUIState.contextPanelMode = null;
    vi.mocked(channelApi.summarizeChannel).mockResolvedValue({
      data: {
        summary: 'Nothing to summarize.',
        provider: 'test',
        model: 'test-model',
        message_count: 0,
      },
    } as never);
  });

  it('shows an announced inline alert when channel summarization fails', async () => {
    vi.mocked(channelApi.summarizeChannel).mockRejectedValue(new Error('AI provider is not configured.'));
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Summarize Channel' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to summarize channel: AI provider is not configured.',
    );
  });

  it('replaces an open ContextPanel instead of stacking the summary over it', async () => {
    mockUIState.contextPanelMode = 'members';
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Summarize Channel' }));

    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('members');
    expect(await screen.findByText('Nothing to summarize.')).toBeInTheDocument();
  });
});
