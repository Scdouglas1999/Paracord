import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
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
  contextPanelMode: null as string | null,
  toggleContextPanelMode: vi.fn(),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: vi.fn(),
  setCommandPaletteOpen: vi.fn(),
  setGuildSettingsId: vi.fn(),
  connectionStatus: 'connected',
  connectionLatency: 42,
}));

const mockChannelState = vi.hoisted(() => ({ channelsByGuild: {}, channelsById: {} as Record<string, unknown> }));

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

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => mockPermissions,
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: { channelsByGuild: Record<string, unknown[]>; channelsById: Record<string, unknown> }) => unknown) =>
    selector(mockChannelState),
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

function renderDmTopBar() {
  render(
    <MemoryRouter initialEntries={['/app/dms/dm-1']}>
      <Routes>
        <Route
          path="/app/dms/:channelId"
          element={<TopBar isDM recipientName="Ada" dmChannelId="dm-1" />}
        />
        <Route path="/app/dms" element={<div>Messages index</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TopBar DM voice calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelState.channelsById = {};
    useToastStore.setState({ toasts: [] });
    mockVoiceState.connected = false;
    mockVoiceState.systemAudioCaptureActive = false;
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

  // §6.5: there is no docked member list anywhere. The people who are here now
  // are the header's lit strip, and its sheet is the only full list — for a
  // group DM exactly as for a room.
  it('offers no member-list control, in a group DM or a one-to-one', () => {
    mockChannelState.channelsById = { 'dm-1': { id: 'dm-1', type: 3, channel_type: 3, name: 'Group' } };
    renderDmTopBar();
    expect(screen.queryByRole('button', { name: 'Member List' })).not.toBeInTheDocument();

    mockChannelState.channelsById = { 'dm-1': { id: 'dm-1', type: 1, channel_type: 1 } };
    renderDmTopBar();
    expect(screen.queryByRole('button', { name: 'Member List' })).not.toBeInTheDocument();
  });

  // The one list that survives §6.5: who a group message is addressed to, which
  // is editable. It lives in the labeled overflow, never docked, and a
  // one-to-one has no such list — there is one other person and the header
  // strip already names them.
  it('offers the group message its people, from the overflow, and only there', async () => {
    const user = userEvent.setup();
    mockChannelState.channelsById = { 'dm-1': { id: 'dm-1', type: 3, channel_type: 3, name: 'Group' } };
    renderDmTopBar();
    await user.click(screen.getByRole('button', { name: 'More channel actions' }));
    expect(screen.getByRole('menuitem', { name: 'People in this message' })).toBeInTheDocument();
  });

  // The group name drops to its own full-width line on a phone
  // (components.css, <=480px container). Because that line is `w-full` it
  // breaks the header's flex row wherever it sits, so it has to come AFTER the
  // actions: ordered before them it pushed the action row onto a THIRD row and
  // a group DM spent 154px of a 664px viewport on a header holding one name.
  it('puts the phone group-message title after the actions so the header stays two rows', () => {
    mockChannelState.channelsById = { 'dm-1': { id: 'dm-1', type: 3, channel_type: 3, name: 'Group' } };
    renderDmTopBar();

    const title = document.querySelector('.chat-header-mobile-dm-title');
    const actions = screen.getByRole('button', { name: 'More channel actions' });
    expect(title).not.toBeNull();
    expect(
      title!.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it('offers no people list for a one-to-one message', async () => {
    const user = userEvent.setup();
    mockChannelState.channelsById = { 'dm-1': { id: 'dm-1', type: 1, channel_type: 1 } };
    renderDmTopBar();
    await user.click(screen.getByRole('button', { name: 'More channel actions' }));
    expect(screen.queryByRole('menuitem', { name: 'People in this message' })).not.toBeInTheDocument();
  });

  it('announces active system audio capture separately from conversation actions', () => {
    mockVoiceState.systemAudioCaptureActive = true;
    renderDmTopBar();
    expect(screen.getByRole('status', { name: 'System audio capture is active' })).toHaveTextContent('System audio capture is active');
    expect(screen.getByRole('button', { name: 'Start direct message voice call' })).toBeVisible();
  });

  it('returns from a direct-message conversation to the Messages index', async () => {
    const user = userEvent.setup();
    renderDmTopBar();

    await user.click(screen.getByRole('button', { name: 'Back to messages' }));

    expect(screen.getByText('Messages index')).toBeInTheDocument();
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
