import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

// The right-cluster context toggles are the single-source-of-truth drivers for
// the shell-owned ContextPanel (layout-spec §1/§2). TopBar only sets the mode;
// the pins/search surfaces themselves live in ContextPanel, not here.
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

const mockVoiceState = vi.hoisted(() => ({
  systemAudioCaptureActive: false,
}));

const mockPermissions = vi.hoisted(() => ({
  permissions: 0n,
  isAdmin: false,
  isOwner: false,
  isLoading: false,
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

vi.mock('../../api/auth', () => ({
  authApi: {
    getReadStates: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    summarizeChannel: vi.fn(),
    getFollowers: vi.fn(),
    addFollower: vi.fn(),
    removeFollower: vi.fn(),
  },
}));

function renderChannelTopBar() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/channels/channel-1']}>
      <Routes>
        <Route
          path="/app/guilds/:guildId/channels/:channelId"
          element={<TopBar channelName="general" guildId="guild-1" guildName="Emerald HQ" />}
        />
        <Route path="/app/guilds/:guildId" element={<div>Guild Home Route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TopBar context-panel toggles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUIState.contextPanelMode = null;
    mockPermissions.permissions = 0n;
    mockPermissions.isAdmin = false;
  });

  it('drives the shell ContextPanel mode from each right-cluster toggle', () => {
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Pinned Messages' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('pins');

    fireEvent.click(screen.getByRole('button', { name: 'Search Messages' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('search');

    fireEvent.click(screen.getByRole('button', { name: 'Member List' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('members');

    fireEvent.click(screen.getByRole('button', { name: 'Guild Leaderboard' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('economy');

    fireEvent.click(screen.getByRole('button', { name: 'Threads' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('threads');
  });

  it('reflects the active ContextPanel mode as the pressed toggle', () => {
    mockUIState.contextPanelMode = 'pins';
    renderChannelTopBar();

    expect(screen.getByRole('button', { name: 'Pinned Messages' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Member List' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('keeps secondary channel actions reachable from the narrow-screen overflow menu', () => {
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    const menu = screen.getByRole('menu', { name: 'More channel actions' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Catch up summary' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Space leaderboard' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Pinned messages' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('pins');
    expect(screen.queryByRole('menu', { name: 'More channel actions' })).not.toBeInTheDocument();
  });

  it('no longer renders the pinned-messages surface inside the TopBar', async () => {
    const user = userEvent.setup();
    renderChannelTopBar();

    await user.click(screen.getByRole('button', { name: 'Pinned Messages' }));

    expect(screen.queryByText('No pinned messages yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unpin this message' })).not.toBeInTheDocument();
  });

  it('navigates to the guild Home from the breadcrumb chip', async () => {
    const user = userEvent.setup();
    renderChannelTopBar();

    await user.click(screen.getByRole('button', { name: 'Go to Emerald HQ home' }));

    expect(await screen.findByText('Guild Home Route')).toBeInTheDocument();
  });

  it('hides Space settings without management permissions', () => {
    mockPermissions.isAdmin = false;
    mockPermissions.permissions = 0n;
    renderChannelTopBar();
    expect(screen.queryByRole('button', { name: 'Space settings' })).not.toBeInTheDocument();
  });

  it('shows Space settings for guild admins and opens the overlay', () => {
    mockPermissions.isAdmin = true;
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'Space settings' }));
    expect(mockUIState.setGuildSettingsId).toHaveBeenCalledWith('guild-1');
  });
});
