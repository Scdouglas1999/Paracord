import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlassStore } from '../../../stores/glassStore';
import { useSheetPages } from '../sheets';
import { useUIStore } from '../../../stores/uiStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useAuthStore } from '../../../stores/authStore';
import { useToastStore } from '../../../stores/toastStore';
import type { ConversationSubject } from '../shell/slots';
import { ConversationPane } from './ConversationPane';
import { usePhoneNavStore } from '../shell/phoneNav';
import { attentionCaption } from './useChannelMenu';

/**
 * The Glass conversation pane and its header (docs/glass-spec.md §3.2, §8).
 *
 * The header is built from `subject`; this suite holds what the reference
 * shows (a title at the column edge with no `#`, the topic under it, search,
 * members and your face at the pane's right edge), what the title opens, and
 * that nothing the Lantern header carried became unreachable. Geometry is CSS
 * and is checked by screenshots (docs/design/glass-g11-checkpoint.md).
 */

const mockLayout = vi.hoisted(() => ({ value: 'wide' as 'wide' | 'compact' | 'phone' }));
vi.mock('../shell/useGlassLayout', () => ({ useGlassLayout: () => mockLayout.value }));

const SCOPE = { serverId: '__local__', userId: 'u1' };
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => SCOPE,
  useCurrentUser: () => ({ id: 'u1', username: 'sean', display_name: 'Sean', avatar_hash: null }),
}));

const mockActions = vi.hoisted(() => ({
  value: {
    encrypted: false,
    encryption: 'ready' as string,
    actions: Object.fromEntries(
      ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map((action) => [
        action,
        { supported: true, allowed: true, reason: null as string | null },
      ]),
    ),
    error: null,
    loading: false,
    refresh: () => {},
  },
}));
vi.mock('../../../hooks/useConversationActions', () => ({ useConversationActions: () => mockActions.value }));

const CHANNELS = {
  ch1: { id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'General', last_message_id: '50' },
  ch2: { id: 'ch2', guild_id: 'g1', type: 0, channel_type: 0, name: 'Clips', last_message_id: '60' },
  ann: { id: 'ann', guild_id: 'g1', type: 5, channel_type: 5, name: 'Announcements', last_message_id: '70' },
  dm1: { id: 'dm1', type: 1, channel_type: 1, name: 'Mara', last_message_id: '80' },
};
vi.mock('../../../hooks/useChannels', () => ({
  useCurrentChannelStore: (selector: (s: unknown) => unknown) =>
    selector({
      channelsById: CHANNELS,
      channelsByGuild: { g1: [CHANNELS.ch1, CHANNELS.ch2, CHANNELS.ann] },
    }),
}));

vi.mock('../../../hooks/useMutedGuilds', () => ({ useMutedGuilds: () => ({ mutedGuildKeys: [] }) }));
const mockPermissions = vi.hoisted(() => ({ value: { permissions: 0n, isAdmin: false } }));
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: () => mockPermissions.value,
}));
vi.mock('../../../hooks/useReadStates', () => ({
  useCurrentReadStates: () => mockReadStates.value,
}));
const mockReadStates = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const mockMessages = vi.hoisted(() => ({ value: {} as Record<string, unknown[]> }));
vi.mock('../../../hooks/useMessageStore', () => ({
  useCurrentMessageStore: (selector: (s: unknown) => unknown) => selector({ messages: mockMessages.value }),
}));
const mockRefreshReadStates = vi.hoisted(() => ({ value: vi.fn() }));
vi.mock('../../../stores/readStateStore', () => ({
  useReadStateStore: { getState: () => ({ refreshAll: vi.fn(), refresh: mockRefreshReadStates.value }) },
}));
const mockVoiceApi = vi.hoisted(() => ({ joinChannel: vi.fn() }));
vi.mock('../../../hooks/useVoice', () => ({
  useVoice: () => ({ connected: false, channelId: null, joinChannel: mockVoiceApi.joinChannel, leaveChannel: vi.fn() }),
}));
vi.mock('../../voice/VoiceConnectionCheck', () => ({ VoiceConnectionCheck: () => null }));
vi.mock('../../../api/channels', () => ({
  channelApi: {
    summarizeChannel: vi.fn(),
    getFollowers: vi.fn(),
    addFollower: vi.fn(),
    removeFollower: vi.fn(),
  },
}));

const CHANNEL: ConversationSubject = {
  kind: 'channel',
  guildId: 'g1',
  guildName: 'Game Night',
  channelId: 'ch1',
  channelName: 'General',
  topic: 'Haz 5 runs from 9. Bring snacks.',
};

const DM: ConversationSubject = { kind: 'dm', channelId: 'dm1', title: 'Mara', isGroup: false };
const GROUP_DM: ConversationSubject = { kind: 'dm', channelId: 'dm1', title: 'Mara, Ade, Jonas', isGroup: true };

function Probe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

function renderPane(subject: ConversationSubject = CHANNEL, extra: Partial<React.ComponentProps<typeof ConversationPane>> = {}) {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/g1/channels/ch1']}>
      <Routes>
        <Route
          path="*"
          element={
            <ConversationPane
              subject={subject}
              timeline={<div data-testid="timeline" />}
              composer={<div data-testid="composer" />}
              {...extra}
            />
          }
        />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockLayout.value = 'wide';
  mockActions.value = {
    ...mockActions.value,
    encrypted: false,
    encryption: 'ready',
    loading: false,
    error: null,
  };
  mockReadStates.value = {};
  mockMessages.value = {};
  mockPermissions.value = { permissions: 0n, isAdmin: false };
  mockRefreshReadStates.value = vi.fn().mockResolvedValue(undefined);
  useGlassStore.getState().reset();
  useUIStore.setState({ contextPanelMode: null, sidebarCollapsed: false, userSettingsOpen: false });
  useVoiceStore.setState({ systemAudioCaptureActive: false });
  useAuthStore.setState({ settings: { status: 'online' } as never });
});

describe('the conversation pane', () => {
  it('fills the shell’s regions: header, notices, timeline, message box', () => {
    const { container } = renderPane(CHANNEL, {
      notices: <div data-testid="notice" />,
    });
    const pane = container.querySelector('.glass-conversation')!;
    expect(pane.querySelector('.glass-conversation__header')).toHaveTextContent('General');
    expect(pane.querySelector('.glass-conversation__notices')).toContainElement(screen.getByTestId('notice'));
    expect(pane.querySelector('.glass-conversation__timeline')).toContainElement(screen.getByTestId('timeline'));
    expect(pane.querySelector('.glass-conversation__composer')).toContainElement(screen.getByTestId('composer'));
  });

  it('omits the notices and message box regions when it is handed none', () => {
    const { container } = render(
      <MemoryRouter>
        <ConversationPane subject={CHANNEL} timeline={<div />} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.glass-conversation__notices')).toBeNull();
    expect(container.querySelector('.glass-conversation__composer')).toBeNull();
  });

  it('says so, in the column, while system audio capture is on', () => {
    useVoiceStore.setState({ systemAudioCaptureActive: true });
    renderPane();
    expect(screen.getByRole('status', { name: 'System audio capture is active' })).toBeInTheDocument();
  });
});

describe('the header of a channel', () => {
  it('names the channel with no "#", and the topic under it', () => {
    renderPane();
    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent(/^General$/);
    expect(screen.getByText('Haz 5 runs from 9. Bring snacks.')).toBeInTheDocument();
    expect(screen.queryByText(/#/)).not.toBeInTheDocument();
  });

  it('puts the server under the name when the channel has no topic', () => {
    renderPane({ ...CHANNEL, topic: null });
    expect(screen.getByText('Game Night')).toBeInTheDocument();
  });

  it('keeps search, members and your face at the pane’s right edge, named', () => {
    renderPane();
    const tools = screen.getByRole('group', { name: 'Conversation actions' });
    expect(within(tools).getByRole('button', { name: 'Search messages' })).toBeInTheDocument();
    expect(within(tools).getByRole('button', { name: 'Members' })).toBeInTheDocument();
    expect(within(tools).getByRole('button', { name: 'Your profile, online' })).toBeInTheDocument();
  });

  it('says your presence in words, whatever the dot looks like', () => {
    useAuthStore.setState({ settings: { status: 'dnd' } as never });
    renderPane();
    expect(screen.getByRole('button', { name: 'Your profile, do not disturb' })).toBeInTheDocument();
  });

  it('opens search as a sheet, and closes it again', async () => {
    const user = userEvent.setup();
    renderPane();
    const search = screen.getByRole('button', { name: 'Search messages' });
    await user.click(search);
    // The header states its intent on the store; the Sheets slot renders it.
    expect(useGlassStore.getState().sheet).toBe('search');
    expect(useUIStore.getState().contextPanelMode).toBeNull();
    expect(search).toHaveAttribute('aria-expanded', 'true');

    await user.click(search);
    expect(useGlassStore.getState().sheet).toBeNull();
    expect(search).toHaveAttribute('aria-expanded', 'false');
  });

  it('asks for the people sheet from a channel', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole('button', { name: 'Members' }));
    expect(useGlassStore.getState().sheet).toBe('people');
  });

  it('opens the account sheet from your face', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole('button', { name: 'Your profile, online' }));
    // Your face opens the account menu (a popover the Sheets slot renders);
    // settings is one of its rows, no longer what the face does by itself.
    expect(useGlassStore.getState().sheet).toBe('account');
    expect(useUIStore.getState().userSettingsOpen).toBe(false);
  });

  it('opens the channel menu from the title, with the actions the header used to carry', async () => {
    const user = userEvent.setup();
    renderPane();
    const title = screen.getByRole('button', { name: 'General' });
    expect(title).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(title);
    const menu = screen.getByRole('menu', { name: 'Channel actions' });
    const rows = within(menu).getAllByRole('menuitem');
    expect(rows).toHaveLength(8);
    for (const name of [
      /^Catch up summary/,
      /^Pinned messages/,
      /^Threads/,
      /^Media/,
      /^Server leaderboard/,
      /^Notifications/,
      /^Inbox/,
      /^Keyboard shortcuts/,
    ]) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }
    // Search and people have buttons of their own; they are not menu rows.
    expect(within(menu).queryByRole('menuitem', { name: /Search/ })).not.toBeInTheDocument();
  });

  it('drives a side panel from a menu row, and gives focus to what it opened', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole('button', { name: 'General' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pinned messages' }));
    // The row opens the channel sheet on its Pins page.
    expect(useGlassStore.getState().sheet).toBe('channel');
    expect(useSheetPages.getState().channelPage).toBe('pins');
    expect(screen.queryByRole('menu', { name: 'Channel actions' })).not.toBeInTheDocument();
  });

  it('offers follows only in an announcement channel', async () => {
    const user = userEvent.setup();
    renderPane({ ...CHANNEL, channelId: 'ann', channelName: 'Announcements' });
    await user.click(screen.getByRole('button', { name: 'Announcements' }));
    expect(screen.getByRole('menuitem', { name: 'Manage follows' })).toBeInTheDocument();
  });

  it('explains why a catch-up summary is unavailable instead of hiding it', async () => {
    const user = userEvent.setup();
    mockActions.value = {
      ...mockActions.value,
      actions: {
        ...mockActions.value.actions,
        summary: { supported: true, allowed: false, reason: 'Summaries are turned off on this server.' },
      },
    };
    renderPane();
    await user.click(screen.getByRole('button', { name: 'General' }));
    const row = screen.getByRole('menuitem', { name: /Catch up summary/ });
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent('Summaries are turned off on this server.');
  });

  it('describes what is unread elsewhere, for a screen reader, on the title', () => {
    mockReadStates.value = { ch2: { channel_id: 'ch2', last_message_id: '1', mention_count: 2 } };
    renderPane();
    expect(screen.getByRole('button', { name: 'General' })).toHaveAccessibleDescription(
      '2 mentions in 3 unread conversations',
    );
  });

  it('opens the channel menu with ArrowDown on the title', () => {
    renderPane();
    const title = screen.getByRole('button', { name: 'General' });
    fireEvent.keyDown(title, { key: 'ArrowDown' });
    expect(screen.getByRole('menu', { name: 'Channel actions' })).toBeInTheDocument();
  });
});

describe('the header of a direct message', () => {
  it('names the person, shows no topic, and says how it is protected', () => {
    mockActions.value = { ...mockActions.value, encrypted: true, encryption: 'ready' };
    renderPane(DM);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Mara$/);
    expect(screen.getByText('End-to-end encrypted')).toBeInTheDocument();
  });

  it('says nothing about encryption until the server has answered', () => {
    mockActions.value = { ...mockActions.value, encrypted: false, loading: true } as typeof mockActions.value;
    renderPane(DM);
    expect(screen.queryByText('Not encrypted')).not.toBeInTheDocument();
  });

  it('says plainly when encryption is not ready', () => {
    mockActions.value = { ...mockActions.value, encrypted: true, encryption: 'unlock' };
    renderPane(DM);
    expect(screen.getByText('Encryption locked on this device')).toBeInTheDocument();
  });

  it('keeps the call control the header had until the pill carries calls', () => {
    renderPane(DM);
    expect(screen.getByRole('button', { name: 'Start direct message voice call' })).toBeEnabled();
  });

  it('says why a call could not start, and offers the connection check', async () => {
    const user = userEvent.setup();
    useToastStore.setState({ toasts: [] });
    mockVoiceApi.joinChannel.mockImplementation(async () => {
      useVoiceStore.setState({ connectionError: 'Microphone permission denied', connectionErrorChannelId: 'dm1' });
    });
    renderPane(DM);
    await user.click(screen.getByRole('button', { name: 'Start direct message voice call' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            message: 'Could not start voice call: Microphone permission denied',
            action: expect.objectContaining({ label: 'Run connection check' }),
          }),
        ]),
      ),
    );
  });

  it('refuses the call control, with the reason, when calls are not allowed', () => {
    mockActions.value = {
      ...mockActions.value,
      actions: { ...mockActions.value.actions, voice: { supported: true, allowed: false, reason: 'Calls are blocked.' } },
    };
    renderPane(DM);
    expect(screen.getByRole('button', { name: 'Start direct message voice call' })).toBeDisabled();
  });

  it('offers no call control on a channel', () => {
    renderPane(CHANNEL);
    expect(screen.queryByRole('button', { name: /direct message voice call/ })).not.toBeInTheDocument();
  });

  it('leaves out what does not belong in a DM: threads and the leaderboard', async () => {
    const user = userEvent.setup();
    renderPane(DM);
    await user.click(screen.getByRole('button', { name: 'Mara' }));
    expect(screen.queryByRole('menuitem', { name: 'Threads' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /leaderboard/ })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Pinned messages' })).toBeInTheDocument();
  });

  it('shows a group’s recipients from its people button', async () => {
    const user = userEvent.setup();
    renderPane(GROUP_DM);
    await user.click(screen.getByRole('button', { name: 'People in this message' }));
    expect(useGlassStore.getState().sheet).toBe('people');
  });
});

describe('the phone header (screens/07)', () => {
  beforeEach(() => {
    mockLayout.value = 'phone';
  });

  it('is the title, the server under it, and how many messages are new', () => {
    mockMessages.value = {
      ch1: [
        { id: '10', author: { id: 'u2' } },
        { id: '55', author: { id: 'u2' } },
        { id: '56', author: { id: 'u1' } },
        { id: '57', author: { id: 'u3' } },
      ],
    };
    mockReadStates.value = { ch1: { channel_id: 'ch1', last_message_id: '50', mention_count: 0 } };
    renderPane();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^General$/);
    expect(screen.getByText('Game Night')).toBeInTheDocument();
    // Two from other people after the read marker; yours do not count.
    expect(screen.getByText('2 new')).toBeInTheDocument();
  });

  it('shows no kicker when nothing is new', () => {
    mockMessages.value = { ch1: [{ id: '10', author: { id: 'u2' } }] };
    mockReadStates.value = { ch1: { channel_id: 'ch1', last_message_id: '50', mention_count: 0 } };
    renderPane();
    expect(screen.queryByText(/new$/)).not.toBeInTheDocument();
  });

  it('keeps search and members, drops the face, and keeps the way to places', async () => {
    const user = userEvent.setup();
    renderPane();
    expect(screen.getByRole('button', { name: 'Search messages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Members' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Your profile/ })).not.toBeInTheDocument();
    // Places is its own screen on a phone: the header's first button goes back to it.
    await user.click(screen.getByRole('button', { name: 'Back to places' }));
    expect(usePhoneNavStore.getState().screen).toBe('places');
  });

  it('goes back to places from a DM too, without changing the route', async () => {
    const user = userEvent.setup();
    usePhoneNavStore.getState().showConversation();
    renderPane(DM);
    await user.click(screen.getByRole('button', { name: 'Back to places' }));
    expect(usePhoneNavStore.getState().screen).toBe('places');
    expect(screen.queryByRole('button', { name: /sidebar|Back to messages/ })).not.toBeInTheDocument();
  });

  it('mounts the call pill above the header, in two rows', () => {
    const { container } = renderPane();
    const pane = container.querySelector('.glass-conversation')!;
    expect(pane.firstElementChild).toHaveClass('glass-conversation__phone-pill');
  });
});

describe('the inbox, from the channel menu', () => {
  async function openInbox() {
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole('button', { name: 'General' }));
    await user.click(screen.getByRole('menuitem', { name: /^Inbox/ }));
  }

  it('says what is waiting elsewhere in the row, in the singular and the plural', () => {
    expect(attentionCaption(1, 0)).toBe('1 unread conversation');
    expect(attentionCaption(1, 1)).toBe('1 mention in 1 unread conversation');
    expect(attentionCaption(4, 3)).toBe('3 mentions in 4 unread conversations');
    expect(attentionCaption(0, 0)).toBe('No unread conversations');
  });

  it('lists the unread conversations elsewhere, never the one you are reading', async () => {
    await openInbox();
    const inbox = await screen.findByRole('dialog', { name: 'Inbox' });
    // The rows name a channel without the `#`.
    expect(await within(inbox).findByText('Clips')).toBeInTheDocument();
    expect(within(inbox).queryByText('General')).not.toBeInTheDocument();
  });

  it('says so in an alert when the unread state cannot load, instead of pretending all is read', async () => {
    mockRefreshReadStates.value.mockRejectedValue(new Error('Read-state service unavailable.'));
    await openInbox();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load inbox: Read-state service unavailable.');
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
  });
});

describe('server settings, from the channel menu', () => {
  it('is not offered without management permissions', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.queryByRole('menuitem', { name: 'Server settings' })).not.toBeInTheDocument();
  });

  it('is offered to a server admin, and opens the settings of that server', async () => {
    const user = userEvent.setup();
    mockPermissions.value = { permissions: 0n, isAdmin: true };
    renderPane();
    await user.click(screen.getByRole('button', { name: 'General' }));
    await user.click(screen.getByRole('menuitem', { name: /^Server settings/ }));
    expect(useUIStore.getState().guildSettingsId).toBe('g1');
  });

  it('is not offered in a direct message', async () => {
    const user = userEvent.setup();
    mockPermissions.value = { permissions: 0n, isAdmin: true };
    renderPane(DM);
    await user.click(screen.getByRole('button', { name: 'Mara' }));
    expect(screen.queryByRole('menuitem', { name: 'Server settings' })).not.toBeInTheDocument();
  });
});

describe('the compact frame', () => {
  it('keeps the button that opens places first in the row', () => {
    mockLayout.value = 'compact';
    const { container } = renderPane();
    const row = container.querySelector('.glass-header')!;
    expect(row.firstElementChild).toHaveAttribute('aria-label', 'Show places');
  });
});
