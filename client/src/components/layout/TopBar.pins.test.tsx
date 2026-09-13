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

// The light seam is stubbed here: this suite mocks the stores down to the
// fields the header's menus need, and light reads half a dozen more. Light
// itself is covered in components/message/TextRoom.test.tsx.
vi.mock('../message/messageLight', () => import('../../test/messageLightMock'));
vi.mock('../../hooks/useLights', () => import('../../test/messageLightMock'));
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
    getPins: vi.fn().mockResolvedValue({ data: [] }),
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

    // §7.4: search, pins and threads are the header's own controls; the
    // overflow menu keeps them for the narrow layout (layout-spec §7.8).
    fireEvent.click(screen.getAllByRole('button', { name: 'Pinned messages' })[0]);
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('pins');

    fireEvent.click(screen.getByRole('button', { name: 'Search messages' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('search');

    fireEvent.click(screen.getByRole('button', { name: 'Threads' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('threads');

    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Building leaderboard/ }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('economy');

    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Pinned messages/ }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('pins');
  });

  it('reflects the active ContextPanel mode as the pressed toggle', () => {
    mockUIState.contextPanelMode = 'pins';
    renderChannelTopBar();

    expect(screen.getByRole('button', { name: 'Close Pinned messages' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Search messages' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('keeps secondary channel actions reachable from the narrow-screen overflow menu', () => {
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    const menu = screen.getByRole('menu', { name: 'Channel actions' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Catch up summary' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Building leaderboard' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Pinned messages' }));
    expect(mockUIState.toggleContextPanelMode).toHaveBeenCalledWith('pins');
    expect(screen.queryByRole('menu', { name: 'Channel actions' })).not.toBeInTheDocument();
  });

  it('no longer renders the pinned-messages surface inside the TopBar', async () => {
    const user = userEvent.setup();
    renderChannelTopBar();

    await user.click(screen.getByRole('button', { name: 'More channel actions' }));
    await user.click(screen.getByRole('menuitem', { name: /^Pinned messages/ }));

    expect(screen.queryByText('No pinned messages yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unpin this message' })).not.toBeInTheDocument();
  });

  it('navigates to the guild Home from the breadcrumb chip', async () => {
    const user = userEvent.setup();
    renderChannelTopBar();

    await user.click(screen.getByRole('button', { name: 'Go to Emerald HQ home' }));

    expect(await screen.findByText('Guild Home Route')).toBeInTheDocument();
  });

  it('hides Building settings without management permissions', () => {
    mockPermissions.isAdmin = false;
    mockPermissions.permissions = 0n;
    renderChannelTopBar();
    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Building settings' })).not.toBeInTheDocument();
  });

  it('shows Building settings for guild admins and opens the overlay', () => {
    mockPermissions.isAdmin = true;
    renderChannelTopBar();

    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Building settings/ }));
    expect(mockUIState.setGuildSettingsId).toHaveBeenCalledWith('guild-1');
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
