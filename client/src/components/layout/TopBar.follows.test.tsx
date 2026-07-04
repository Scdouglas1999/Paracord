import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  connectionStatus: 'connected',
  connectionLatency: 42,
}));

const mockVoiceState = vi.hoisted(() => ({
  systemAudioCaptureActive: false,
}));

const mockChannels = vi.hoisted(() => ({
  channelsByGuild: {
    'guild-1': [
      {
        id: 'ann-1',
        type: 5,
        channel_type: 5,
        guild_id: 'guild-1',
        name: 'announcements',
        position: 0,
        nsfw: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'text-1',
        type: 0,
        channel_type: 0,
        guild_id: 'guild-1',
        name: 'general',
        position: 1,
        nsfw: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  },
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: typeof mockUIState) => unknown) => selector(mockUIState),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: typeof mockChannels) => unknown) => selector(mockChannels),
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

function renderAnnouncementTopBar() {
  render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/channels/ann-1']}>
      <Routes>
        <Route
          path="/app/guilds/:guildId/channels/:channelId"
          element={<TopBar channelName="announcements" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TopBar channel follows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(channelApi.getFollowers).mockResolvedValue({ data: [] } as never);
    vi.mocked(channelApi.addFollower).mockResolvedValue({ data: {} } as never);
    vi.mocked(channelApi.removeFollower).mockResolvedValue({ data: {} } as never);
  });

  it('shows an inline alert when following a channel fails', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.addFollower).mockRejectedValue(new Error('Manage Webhooks is required.'));
    renderAnnouncementTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Manage follows' }));
    await waitFor(() => expect(channelApi.getFollowers).toHaveBeenCalledWith('ann-1'));
    await user.click(await screen.findByRole('button', { name: 'Follow' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to follow channel: Manage Webhooks is required.',
    );
  });

  it('shows an inline alert when unfollowing a channel fails', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.getFollowers).mockResolvedValue({
      data: [{ id: 'follow-1', target_channel_id: 'text-1', target_guild_id: 'guild-1' }],
    } as never);
    vi.mocked(channelApi.removeFollower).mockRejectedValue(new Error('Follow target was already removed.'));
    renderAnnouncementTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Manage follows' }));
    await waitFor(() => expect(channelApi.getFollowers).toHaveBeenCalledWith('ann-1'));
    await user.click(await screen.findByRole('button', { name: 'Unfollow' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to unfollow channel: Follow target was already removed.',
    );
  });
});
