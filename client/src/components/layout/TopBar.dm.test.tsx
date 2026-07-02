import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../stores/toastStore';
import { TopBar } from './TopBar';

const mockVoiceState = vi.hoisted(() => ({
  connected: false,
  channelId: null as string | null,
  systemAudioCaptureActive: false,
  connectionError: null as string | null,
  connectionErrorChannelId: null as string | null,
}));

const mockVoiceApi = vi.hoisted(() => ({
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
}));

const mockUIState = vi.hoisted(() => ({
  toggleMemberPanel: vi.fn(),
  sidebarOpen: true,
  toggleSidebar: vi.fn(),
  setSidebarCollapsed: vi.fn(),
  memberPanelOpen: true,
  setCommandPaletteOpen: vi.fn(),
  toggleSearchPanel: vi.fn(),
  searchPanelOpen: false,
  connectionStatus: 'connected',
  connectionLatency: 42,
}));

vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({
    connected: mockVoiceState.connected,
    channelId: mockVoiceState.channelId,
    joinChannel: mockVoiceApi.joinChannel,
    leaveChannel: mockVoiceApi.leaveChannel,
  }),
}));

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: Object.assign(
    (selector: (state: typeof mockVoiceState) => unknown) => selector(mockVoiceState),
    { getState: () => mockVoiceState },
  ),
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: typeof mockUIState) => unknown) => selector(mockUIState),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: { channelsByGuild: Record<string, unknown[]> }) => unknown) =>
    selector({ channelsByGuild: {} }),
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

function renderDmTopBar() {
  render(
    <MemoryRouter initialEntries={['/app/dms/dm-1']}>
      <Routes>
        <Route
          path="/app/dms/:channelId"
          element={<TopBar isDM recipientName="Ada" dmChannelId="dm-1" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TopBar DM voice calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    mockVoiceState.connected = false;
    mockVoiceState.channelId = null;
    mockVoiceState.connectionError = null;
    mockVoiceState.connectionErrorChannelId = null;
    mockVoiceApi.joinChannel.mockResolvedValue(undefined);
  });

  it('shows a toast when a direct-message voice call fails to join', async () => {
    const user = userEvent.setup();
    mockVoiceApi.joinChannel.mockImplementation(async () => {
      mockVoiceState.connectionError = 'Microphone permission denied';
      mockVoiceState.connectionErrorChannelId = 'dm-1';
    });
    renderDmTopBar();

    await user.click(screen.getByRole('button', { name: 'Start direct message voice call' }));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Could not start voice call: Microphone permission denied',
          }),
        ]),
      );
    });
  });
});
