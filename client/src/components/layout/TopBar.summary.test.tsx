import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
import { TopBar } from './TopBar';

// The light seam is stubbed here: this suite mocks the stores down to the
// fields the header's menus need, and light reads half a dozen more. Light
// itself is covered in components/message/TextRoom.test.tsx.
vi.mock('../message/messageLight', () => import('../../test/messageLightMock'));
vi.mock('../../hooks/useLights', () => import('../../test/messageLightMock'));

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
    getPins: vi.fn().mockResolvedValue({ data: [] }),
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

    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Catch up summary/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to summarize channel: AI provider is not configured.',
    );
  });

  it('replaces an open ContextPanel instead of stacking the summary over it', async () => {
    mockUIState.contextPanelMode = 'members';
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Catch up summary/ }));

    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('members');
    expect(await screen.findByText('Nothing to summarize.')).toBeInTheDocument();
  });
});

vi.mock('../../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useChannels')>('../../hooks/useChannels');
  const { useChannelStore } = await import('../../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore(state => state.channelsByGuild[id] ?? []),
  };
});

vi.mock('../../hooks/useConversationActions', () => ({
  useConversationActions: () => ({
    actions: Object.fromEntries(['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map(action => [action, { supported: true, allowed: true, reason: null }])),
    error: null, loading: false, refresh: vi.fn(),
  }),
}));
