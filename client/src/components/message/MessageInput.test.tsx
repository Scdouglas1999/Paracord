vi.mock('../../lib/channelView', () => ({ getAccountChannelView: (_scope: unknown, state: unknown) => state }));
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { channelApi } from '../../api/channels';
import { MessageInput, composerPlaceholder, replyPlaceholder } from './MessageInput';
import { stageComposerFiles } from './composerFiles';
import { groupEnrollmentReason } from '../../lib/messages/messagingReadiness';
import { configureMotion, onMotion, resetMotionBusForTests, resetMotionSwitchForTests, type MotionEvents } from '../../lib/motion';

const mockEncryption = vi.hoisted(() => ({ encrypted: false, encryption: 'ready' }));
const mockActionOverrides = vi.hoisted(() => ({} as Record<string, { supported: boolean; allowed: boolean; reason: string | null }>));

// Mock stores
const mockOwner = vi.hoisted(() => ({ serverId: '__local__', userId: 'u1' }));
const mockMessaging = vi.hoisted(() => ({
  runtimes: new Map<string, import('../../test/messageInputRuntimeMock').FakeMessagingRuntime>(),
}));
vi.mock('../../lib/messages/accountMessagingRuntime', async () => {
  const { fakeAccountMessagingRuntime } = await import('../../test/messageInputRuntimeMock');
  return {
    getAccountMessagingRuntime: (scope: { serverId: string; userId: string }) =>
      fakeAccountMessagingRuntime(mockMessaging.runtimes, scope),
  };
});
const mockSendMessage = vi.fn();
const mockScheduleMessage = vi.fn();
const mockAddMessage = vi.fn();
const mockUpload = vi.fn();
const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
}));
vi.mock('../../hooks/useMessageStore', () => ({
  useCurrentMessageStoreApi: () => Object.assign(
    () => ({}),
    {
      scope: { ...mockOwner },
      getState: () => ({
        sendMessage: mockSendMessage,
        scheduleMessage: mockScheduleMessage,
        addMessage: mockAddMessage,
      }),
    },
  ),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        channelsByGuild: { g1: [{ id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 }, { id: 'chs', type: 0, channel_type: 0, guild_id: 'g1', name: 'quick-fire', position: 1 }, { id: 'chv', type: 2, channel_type: 2, guild_id: 'g1', name: 'quick voice', position: 3 }] },
        channelsById: {
          ch1: { id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 },
          chs: { id: 'chs', type: 0, channel_type: 0, guild_id: 'g1', name: 'quick-fire', position: 1, rate_limit_per_user: 12 },
          cha: { id: 'cha', type: 5, channel_type: 5, guild_id: 'g1', name: 'announcements', position: 2 },
          gd1: { id: 'gd1', type: 3, channel_type: 3, name: 'Three of us', position: 0,
            recipients: [{ id: 'u1', username: 'me', public_key: 'a'.repeat(64) },
              { id: 'u2', username: 'ada', public_key: null },
              { id: 'u3', username: 'bo', public_key: 'c'.repeat(64) }] },
          gd2: { id: 'gd2', type: 3, channel_type: 3, name: 'All set', position: 0,
            recipients: [{ id: 'u1', username: 'me', public_key: 'a'.repeat(64) },
              { id: 'u3', username: 'bo', public_key: 'c'.repeat(64) }] },
        },
      }),
    {
      getState: () => ({
        channelsByGuild: { g1: [{ id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 }, { id: 'chs', type: 0, channel_type: 0, guild_id: 'g1', name: 'quick-fire', position: 1 }, { id: 'chv', type: 2, channel_type: 2, guild_id: 'g1', name: 'quick voice', position: 3 }] },
        channelsById: {
          ch1: { id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 },
          chs: { id: 'chs', type: 0, channel_type: 0, guild_id: 'g1', name: 'quick-fire', position: 1, rate_limit_per_user: 12 },
          cha: { id: 'cha', type: 5, channel_type: 5, guild_id: 'g1', name: 'announcements', position: 2 },
          gd1: { id: 'gd1', type: 3, channel_type: 3, name: 'Three of us', position: 0,
            recipients: [{ id: 'u1', username: 'me', public_key: 'a'.repeat(64) },
              { id: 'u2', username: 'ada', public_key: null },
              { id: 'u3', username: 'bo', public_key: 'c'.repeat(64) }] },
          gd2: { id: 'gd2', type: 3, channel_type: 3, name: 'All set', position: 0,
            recipients: [{ id: 'u1', username: 'me', public_key: 'a'.repeat(64) },
              { id: 'u3', username: 'bo', public_key: 'c'.repeat(64) }] },
        },
      }),
    },
  ),
}));

vi.mock('../../stores/pollStore', () => ({
  usePollStore: {
    getState: () => ({
      clearPollsForChannel: vi.fn(),
      upsertPoll: vi.fn(),
    }),
  },
}));

vi.mock('../../stores/memberStore', () => ({
  useMemberStore: (selector: (s: { members: Map<string, unknown[]> }) => unknown) =>
    selector({ members: new Map() }),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: BigInt('0x7FFFFFFFFFFFFFFF'), isAdmin: true }),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: mockToast.success,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../hooks/useFileUpload', () => ({
  useFileUpload: () => ({ upload: mockUpload, uploading: false, maxUploadSize: 50 * 1024 * 1024 }),
}));

vi.mock('../../hooks/useTyping', () => ({
  useTyping: () => ({ triggerTyping: vi.fn(), stopTyping: vi.fn() }),
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    createPoll: vi.fn(),
    getFeatureSettings: vi.fn(() => new Promise(() => {})),
    getOverwrites: vi.fn(() => Promise.resolve({ data: [] })),
    listScheduledMessages: vi.fn(() => Promise.resolve({ data: [] })),
  },
}));

vi.mock('./MarkdownToolbar', () => ({
  MarkdownToolbar: () => null,
  applyMarkdownToolbarAction: vi.fn(),
  resolveMarkdownShortcut: vi.fn(() => null),
}));

vi.mock('../ui/EmojiPicker', () => ({
  EmojiPicker: () => <div data-testid="emoji-picker" />,
}));
vi.mock('./GifPicker', () => ({
  GifPicker: () => <div data-testid="gif-picker" />,
}));
vi.mock('./StickerPicker', () => ({
  StickerPicker: () => <div data-testid="sticker-picker" />,
}));
vi.mock('../../api/emojis', () => ({
  emojiApi: { listGuild: vi.fn(() => Promise.resolve({ data: [{ id: '77', name: 'fireball', animated: false }] })) },
}));

vi.mock('../../lib/constants', () => ({
  MAX_MESSAGE_LENGTH: 2000,
  SCHEDULED_MESSAGE_MIN_LEAD_MS: 5000,
}));

function futureDatetimeLocal(daysFromNow = 30): string {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}


/** The tools row shows while the box is open: focus the words, then the chip. */
async function chooseTool(user: ReturnType<typeof userEvent.setup>, name: 'Attach' | 'GIF' | 'Poll' | 'Event' | 'Format') {
  await user.click(screen.getByRole('textbox'));
  await user.click(screen.getByRole('button', { name }));
}

/** Send later lives in the send control's menu (right-click, or a long press). */
async function sendLater(user: ReturnType<typeof userEvent.setup>) {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: 'Send message' }) });
  await user.click(await screen.findByRole('menuitem', { name: /Send later/ }));
}

describe('MessageInput', () => {
  beforeEach(() => {
    mockEncryption.encrypted = false; mockEncryption.encryption = 'ready';
    for (const key of Object.keys(mockActionOverrides)) delete mockActionOverrides[key];
    mockMessaging.runtimes.clear();
    localStorage.clear();
    mockOwner.serverId = '__local__';
    mockOwner.userId = 'u1';
    vi.clearAllMocks();
    mockToast.success.mockClear();
    mockSendMessage.mockResolvedValue(undefined);
    mockScheduleMessage.mockResolvedValue(undefined);
    mockUpload.mockResolvedValue({ id: 'attachment-1' });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.mocked(channelApi.getFeatureSettings).mockImplementation(() => new Promise(() => {}));
  });

  it('offers account-bound encryption setup while retaining the composed draft', async () => {
    mockEncryption.encrypted = true; mockEncryption.encryption = 'setup';
    mockActionOverrides.send = { supported: true, allowed: false, reason: 'Set up encryption before sending in this conversation.' };
    render(<MemoryRouter><MessageInput channelId="ch1" channelName="Alice" /></MemoryRouter>);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'Keep this private draft');
    // The composer holds a blocker back for 400ms so a readiness dip that
    // resolves itself cannot shove the composer mid-send; a real one, like this,
    // is still there when the wait is over.
    const link = await screen.findByRole('link', { name: 'Set up encryption' });
    const destination = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(destination.pathname).toBe('/setup');
    expect(destination.searchParams.get('server')).toBe(mockOwner.serverId);
    expect(destination.searchParams.get('user')).toBe(mockOwner.userId);
    expect(input).toHaveValue('Keep this private draft');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('names the member a group is waiting on, and offers no encryption route out', async () => {
    // The server marks a group channel `encrypted`, so the composer used to
    // reach the 1:1 rung and offer "Set up encryption" — an action that cannot
    // enroll somebody else, beside a timeline saying something different.
    mockEncryption.encrypted = true; mockEncryption.encryption = 'setup';
    mockActionOverrides.send = { supported: true, allowed: false, reason: 'Set up encryption before sending in this conversation.' };
    render(<MemoryRouter><MessageInput channelId="gd1" channelName="Three of us" /></MemoryRouter>);
    const blocker = await screen.findByText(groupEnrollmentReason(['ada']));
    expect(blocker).toBeInTheDocument();
    expect(screen.queryByText(/Set up encryption before sending in this conversation/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Set up encryption' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('keeps the encryption route out when a ready group is blocked on the viewer’s own setup', async () => {
    // The group's roster is complete, so the blocker is this person's identity,
    // not somebody else's — and /setup is exactly the page that resolves it.
    mockEncryption.encrypted = true; mockEncryption.encryption = 'setup';
    mockActionOverrides.send = { supported: true, allowed: false, reason: 'Set up encryption before sending in this conversation.' };
    render(<MemoryRouter><MessageInput channelId="gd2" channelName="All set" /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Set up encryption' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('lets a fully enrolled group compose', async () => {
    mockEncryption.encrypted = true; mockEncryption.encryption = 'ready';
    render(<MemoryRouter><MessageInput channelId="gd2" channelName="All set" conversationKind="group" /></MemoryRouter>);
    const textarea = await screen.findByPlaceholderText('Message All set');
    expect(textarea).not.toBeDisabled();
    expect(screen.queryByText(/Waiting on:/)).not.toBeInTheDocument();
  });

  it('names the channel the message goes to', () => {
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  it('renders with default placeholder when no channel name', () => {
    render(<MessageInput channelId="ch1" guildId="g1" />);
    expect(screen.getByPlaceholderText('Write a message')).toBeInTheDocument();
  });

  it('allows typing in the textarea', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');

    await user.type(textarea, 'Hello world');
    expect(textarea).toHaveValue('Hello world');
  });

  it('sends message on Enter key', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');

    await user.type(textarea, 'Hello');
    await user.keyboard('{Enter}');

    expect(mockSendMessage).toHaveBeenCalledWith('ch1', 'Hello', undefined, [], undefined, {
      revision: expect.any(String),
      content: 'Hello',
    }, undefined);
  });

  it('does not send on Shift+Enter (allows newline)', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');

    await user.type(textarea, 'Line 1');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('does not send empty message', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');

    await user.click(textarea);
    await user.keyboard('{Enter}');

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('clears textarea after successful send', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');

    await user.type(textarea, 'Test message');
    await user.keyboard('{Enter}');

    expect(textarea).toHaveValue('');
  });

  it('does not double-submit when Enter is pressed while a send is in flight', async () => {
    const user = userEvent.setup();
    let resolveSend: (() => void) | undefined;
    mockSendMessage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );

    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');
    await user.type(textarea, 'once');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    resolveSend?.();
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('isolates colliding accounts and keeps typing across an immediate server switch', async () => {
    const user = userEvent.setup();
    const view = render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    await user.type(screen.getByPlaceholderText('Message general'), 'private A');
    await chooseTool(user, 'Poll');
    mockOwner.serverId = 'b';
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByPlaceholderText('Message general')).toHaveValue('');
    expect(screen.queryByPlaceholderText('What should everyone weigh in on?')).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Message general'), 'private B');
    mockOwner.serverId = '__local__';
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByPlaceholderText('Message general')).toHaveValue('private A');
    mockOwner.serverId = 'b';
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByPlaceholderText('Message general')).toHaveValue('private B');
  });

  it('preserves typing during delivery and does not cancel another composer reply', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    mockSendMessage.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const cancelReply = vi.fn();
    const view = render(<MessageInput channelId="ch1" channelName="general" onCancelReply={cancelReply} />);
    await user.type(screen.getByPlaceholderText('Message general'), 'first');
    await user.keyboard('{Enter}');
    await user.type(screen.getByPlaceholderText('Message general'), ' second');
    view.rerender(<MessageInput channelId="ch2" channelName="next" onCancelReply={cancelReply} />);
    await user.type(screen.getByPlaceholderText('Message next'), 'other channel');
    await act(async () => resolve());
    expect(screen.getByPlaceholderText('Message next')).toHaveValue('other channel');
    expect(cancelReply).not.toHaveBeenCalled();
    view.rerender(<MessageInput channelId="ch1" channelName="general" onCancelReply={cancelReply} />);
    expect(screen.getByPlaceholderText('Message general')).toHaveValue('first second');
  });

  it('clears staged attachments when switching channels', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MessageInput channelId="ch1" guildId="g1" channelName="general" />,
    );
    const file = new File(['png'], 'leak.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    expect(screen.getByAltText('leak.png')).toBeInTheDocument();

    rerender(<MessageInput channelId="ch2" guildId="g1" channelName="random" />);
    expect(screen.queryByAltText('leak.png')).not.toBeInTheDocument();
  });

  it('restores draft text when disabling the poll composer', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');
    await user.type(textarea, 'Should we ship?');
    await chooseTool(user, 'Poll');
    expect(textarea).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(textarea).toHaveValue('Should we ship?');
  });

  it('offers no Poll where polls are not available (an encrypted direct message)', async () => {
    const user = userEvent.setup();
    mockActionOverrides.poll = { supported: false, allowed: false, reason: 'Polls are not available in encrypted direct messages.' };
    render(<MessageInput channelId="ch1" channelName="friend" />);
    await user.click(screen.getByRole('textbox'));
    expect(screen.getByRole('button', { name: 'Attach' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Poll' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('What should everyone weigh in on?')).not.toBeInTheDocument();
  });

  it('retains a completed poll after permission is revoked and prevents submission', async () => {
    const user = userEvent.setup();
    const view = render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    await chooseTool(user, 'Poll');
    await user.type(screen.getByPlaceholderText('What should everyone weigh in on?'), 'Lunch?');
    await user.type(screen.getByPlaceholderText('Option 1'), 'Soup');
    await user.type(screen.getByPlaceholderText('Option 2'), 'Salad');
    mockActionOverrides.poll = { supported: true, allowed: false, reason: 'Permission removed.' };
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByPlaceholderText('What should everyone weigh in on?')).toHaveValue('Lunch?');
    expect(screen.getByPlaceholderText('Option 1')).toHaveValue('Soup');
    expect(screen.getByPlaceholderText('Option 2')).toHaveValue('Salad');
    // The composer holds a blocker back for 400ms (a readiness dip that heals
    // itself must not shove the composer mid-send); a revoked permission does
    // not heal, so the notice arrives and stays.
    expect(await screen.findByRole('status')).toHaveTextContent('Permission removed.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(channelApi.createPoll).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('blocks encrypted file paste and drop while preserving editable text', async () => {
    const user = userEvent.setup();
    mockActionOverrides.attach = { supported: false, allowed: false, reason: 'Encrypted file attachments are not available in this client yet.' };
    const view = render(<MessageInput channelId="ch1" channelName="friend" />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Keep this draft');
    const file = new File(['secret'], 'private.png', { type: 'image/png' });
    fireEvent.paste(textarea, { clipboardData: { files: [file], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' } });
    fireEvent.drop(textarea, { dataTransfer: { files: [file], types: ['Files'] } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    // Attach is offered only where attaching is permitted.
    expect(screen.queryByRole('button', { name: 'Attach' })).not.toBeInTheDocument();
    expect(screen.queryByAltText('private.png')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('Keep this draft');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('blocks already staged attachments after permission revocation without discarding them', async () => {
    const user = userEvent.setup();
    const view = render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    await user.upload(view.container.querySelector('input[type="file"]')!, new File(['keep'], 'retain.txt', { type: 'text/plain' }));
    mockActionOverrides.attach = { supported: true, allowed: false, reason: 'Permission removed.' };
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(screen.getByText('retain.txt')).toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('shows who you are replying to as a chip, and the placeholder says so', async () => {
    const user = userEvent.setup();
    const onCancelReply = vi.fn();
    render(
      <MessageInput
        channelId="ch1"
        guildId="g1"
        channelName="general"
        replyingTo={{ id: 'm1', author: 'TestUser', content: 'Original message' }}
        onCancelReply={onCancelReply}
      />,
    );

    const chip = screen.getByRole('group', { name: 'Replying to TestUser' });
    expect(chip).toHaveTextContent('TestUser');
    // What was said stays reachable, without taking a row of its own.
    expect(chip).toHaveAttribute('title', 'TestUser: Original message');
    expect(screen.getByPlaceholderText('Reply to TestUser')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel reply' }));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  it('shows send button when content is typed', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');

    await user.type(textarea, 'Some text');

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it('warns when the active channel posts messages anonymously', async () => {
    vi.mocked(channelApi.getFeatureSettings).mockResolvedValue({
      data: { anonymous_posting_enabled: true },
    } as never);

    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);

    expect(await screen.findByText('Messages in this channel are posted anonymously')).toBeInTheDocument();
  });

  it('shows server slowmode errors when sending is rate-limited', async () => {
    const user = userEvent.setup();
    mockSendMessage.mockRejectedValue({
      response: { data: { message: 'Slowmode active. Try again in 10 seconds.' } },
    });

    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);

    await user.type(screen.getByPlaceholderText('Message general'), 'Too fast');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Slowmode active. Try again in 10 seconds.')).toBeInTheDocument();
  });

  it('says a refusal once, not twice stacked', async () => {
    // A blocked sender's send is refused with the same sentence the blocker row
    // above the composer already carries. Printing it again underneath read as
    // two separate problems.
    const user = userEvent.setup();
    const refusal = 'Messaging and calls are unavailable between these accounts.';
    mockSendMessage.mockRejectedValue({ response: { data: { message: refusal } } });
    const view = render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    await user.type(screen.getByPlaceholderText('Message general'), 'after the block');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(refusal)).toBeInTheDocument();

    mockActionOverrides.send = { supported: true, allowed: false, reason: refusal };
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(await screen.findByRole('status')).toHaveTextContent(refusal);
    await waitFor(() => expect(screen.getAllByText(refusal)).toHaveLength(1));
  });

  it('previews selected files, uploads them, and sends attachment ids', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const file = new File(['png'], 'release.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, file);

    expect(screen.getByAltText('release.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove release.png' })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Message general'), 'with upload');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledWith(file);
    });
    // An unencrypted guild channel keeps the plaintext upload path: the files
    // become attachment ids and no encrypted submission is made.
    expect(mockSendMessage).toHaveBeenCalledWith('ch1', 'with upload', undefined, ['attachment-1'], undefined, {
      revision: expect.any(String),
      content: 'with upload',
    }, undefined);
    expect(screen.queryByAltText('release.png')).not.toBeInTheDocument();
  });

  it('hands an encrypted conversation’s files to the encrypted producer instead of uploading them', async () => {
    mockEncryption.encrypted = true;
    const user = userEvent.setup();
    render(<MemoryRouter><MessageInput channelId="ch1" guildId="g1" channelName="general" /></MemoryRouter>);
    const file = new File(['private bytes'], 'secret.txt', { type: 'text/plain' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await user.type(screen.getByPlaceholderText('Message general'), 'private file');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    // The plaintext upload path is never taken for an encrypted conversation.
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith('ch1', 'private file', undefined, [], undefined,
      { revision: expect.any(String), content: 'private file' },
      { files: [file], maxCiphertextBytes: 50 * 1024 * 1024 });
  });

  it('does not render unsafe image MIME types as selected-file previews', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const file = new File(['<svg></svg>'], 'vector.svg', { type: 'image/svg+xml' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, file);

    expect(screen.queryByAltText('vector.svg')).not.toBeInTheDocument();
    expect(screen.getByText('vector.svg')).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('schedules a message and switches the submit button into schedule mode', async () => {
    const user = userEvent.setup();
    const scheduledAt = futureDatetimeLocal();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);

    await user.type(screen.getByPlaceholderText('Message general'), 'Standup reminder');
    await sendLater(user);
    expect(screen.getByPlaceholderText('Schedule a message for general')).toHaveValue('Standup reminder');
    await user.type(screen.getByLabelText(/Send at/), scheduledAt);

    const scheduleButton = screen.getByRole('button', { name: 'Schedule message' });
    expect(scheduleButton).toHaveAttribute('title', 'Schedule message');
    await user.click(scheduleButton);

    await waitFor(() =>
      expect(mockScheduleMessage).toHaveBeenCalledWith(
        'ch1',
        'Standup reminder',
        new Date(scheduledAt).toISOString(),
        undefined,
      ),
    );
    expect(mockToast.success).toHaveBeenCalledWith('Message scheduled.');
    expect(screen.queryByPlaceholderText('Schedule message for #general')).not.toBeInTheDocument();
  });

  it('keeps scheduled message content visible and shows server errors on failure', async () => {
    const user = userEvent.setup();
    const scheduledAt = futureDatetimeLocal();
    mockScheduleMessage.mockRejectedValue({
      response: { data: { message: 'Scheduled time must be in the future.' } },
    });

    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);

    await user.type(screen.getByPlaceholderText('Message general'), 'Too soon');
    await sendLater(user);
    const textarea = screen.getByPlaceholderText('Schedule a message for general');
    await user.type(screen.getByLabelText(/Send at/), scheduledAt);
    await user.click(screen.getByRole('button', { name: 'Schedule message' }));

    expect(await screen.findByText('Scheduled time must be in the future.')).toBeInTheDocument();
    expect(textarea).toHaveValue('Too soon');
    expect(screen.getByLabelText(/Send at/)).toHaveValue(scheduledAt);
  });

  it('validates scheduled messages use a future datetime before calling the API', async () => {
    const user = userEvent.setup();
    const pastDate = new Date(Date.now() - 60_000);
    const pad = (value: number) => String(value).padStart(2, '0');
    const pastScheduledAt = [
      pastDate.getFullYear(),
      '-',
      pad(pastDate.getMonth() + 1),
      '-',
      pad(pastDate.getDate()),
      'T',
      pad(pastDate.getHours()),
      ':',
      pad(pastDate.getMinutes()),
    ].join('');

    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);

    await user.type(screen.getByPlaceholderText('Message general'), 'Too late');
    await sendLater(user);
    await user.type(screen.getByLabelText(/Send at/), pastScheduledAt);
    await user.click(screen.getByRole('button', { name: 'Schedule message' }));

    expect(await screen.findByText('Choose a time at least 5 seconds in the future.')).toBeInTheDocument();
    expect(mockScheduleMessage).not.toHaveBeenCalled();
  });
});

describe('the Index message box', () => {
  beforeEach(() => {
    mockEncryption.encrypted = false; mockEncryption.encryption = 'ready';
    for (const key of Object.keys(mockActionOverrides)) delete mockActionOverrides[key];
    mockMessaging.runtimes.clear();
    localStorage.clear();
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue(undefined);
    mockScheduleMessage.mockResolvedValue(undefined);
    vi.mocked(channelApi.getFeatureSettings).mockImplementation(() => new Promise(() => {}));
  });

  const root = () => screen.getByTestId('ix-composer');

  it('names where the message goes, with no "#"', () => {
    expect(composerPlaceholder('General')).toBe('Message General');
    expect(composerPlaceholder('Mara', 'person')).toBe('Message Mara');
    expect(composerPlaceholder()).toBe('Write a message');
    render(<MessageInput channelId="ch1" guildId="g1" channelName="General" />);
    expect(screen.getByPlaceholderText('Message General')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/#/)).not.toBeInTheDocument();
  });

  it('asks "Reply to Jeremy" while replying, and just "Reply" where the chip carries the name', () => {
    expect(replyPlaceholder('Jeremy')).toBe('Reply to Jeremy');
    expect(replyPlaceholder('Jeremy', true)).toBe('Reply');
  });

  it('keeps send quiet until there is something to send, then cream (data-ready)', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="General" />);
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('data-ready', 'false');
    await user.type(screen.getByRole('textbox'), 'hi');
    expect(send).toBeEnabled();
    expect(send).toHaveAttribute('data-ready', 'true');
    await user.clear(screen.getByRole('textbox'));
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('data-ready', 'false');
  });

  it('opens on focus and stays open with words, a reply or attachments; closes empty and unfocused', async () => {
    const user = userEvent.setup();
    const view = render(
      <>
        <button type="button">elsewhere</button>
        <MessageInput channelId="ch1" guildId="g1" channelName="General" />
      </>,
    );
    expect(root()).toHaveAttribute('data-ix-composer-open', 'false');
    // Closed, the tools row is out of reach.
    expect(screen.queryByRole('button', { name: 'Attach' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('textbox'));
    expect(root()).toHaveAttribute('data-ix-composer-open', 'true');
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(root()).toHaveAttribute('data-ix-composer-open', 'false');
    await user.type(screen.getByRole('textbox'), 'words');
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(root()).toHaveAttribute('data-ix-composer-open', 'true');
    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(root()).toHaveAttribute('data-ix-composer-open', 'false');
    view.rerender(
      <>
        <button type="button">elsewhere</button>
        <MessageInput channelId="ch1" guildId="g1" channelName="General" replyingTo={{ id: 'm1', author: 'Jeremy', content: 'run?' }} />
      </>,
    );
    expect(root()).toHaveAttribute('data-ix-composer-open', 'true');
  });

  it('carries Attach, GIF, Poll, Event and Format in the tools row, each only when permitted', async () => {
    const user = userEvent.setup();
    const view = render(<MessageInput channelId="ch1" guildId="g1" channelName="General" />);
    await user.click(screen.getByRole('textbox'));
    const tools = root().querySelector('.ix-composer__tools') as HTMLElement;
    expect(within(tools).getAllByRole('button').map((button) => button.textContent)).toEqual(['Attach', 'GIF', 'Poll', 'Event', 'Format']);
    // No server: no Event. No permission to attach or poll: neither chip.
    view.unmount();
    mockActionOverrides.attach = { supported: true, allowed: false, reason: 'You do not have permission to use this action in this channel.' };
    mockActionOverrides.poll = { supported: true, allowed: false, reason: 'You do not have permission to use this action in this channel.' };
    render(<MessageInput channelId="ch1" channelName="Mara" conversationKind="person" />);
    await user.click(screen.getByRole('textbox'));
    const dm = root().querySelector('.ix-composer__tools') as HTMLElement;
    expect(within(dm).getAllByRole('button').map((button) => button.textContent)).toEqual(['GIF', 'Format']);
  });

  it('keeps only the glyphs, named, in a narrow box', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="General" narrow />);
    expect(root()).toHaveAttribute('data-icon-tools', 'true');
    await user.click(screen.getByRole('textbox'));
    const attach = screen.getByRole('button', { name: 'Attach' });
    expect(attach).toHaveTextContent('');
    expect(attach).toHaveAttribute('title', 'Attach');
    // GIF has no glyph; it keeps its word.
    expect(screen.getByRole('button', { name: 'GIF' })).toHaveTextContent('GIF');
    expect(screen.getByPlaceholderText('Say something')).toBeInTheDocument();
  });

  it('leads the tools row with "Replying to Jeremy ×"', async () => {
    const user = userEvent.setup();
    const onCancelReply = vi.fn();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" replyingTo={{ id: 'm1', author: 'Jeremy', content: 'run?' }} onCancelReply={onCancelReply} />);
    const tools = root().querySelector('.ix-composer__tools') as HTMLElement;
    expect(tools.firstElementChild).toHaveAccessibleName('Replying to Jeremy');
    expect(tools.firstElementChild).toHaveTextContent('Replying to Jeremy');
    await user.click(within(tools).getByRole('button', { name: 'Cancel reply' }));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  it('swaps the tools for the formatting bar on Format, and back on Done', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="General" />);
    await chooseTool(user, 'Format');
    expect(screen.queryByRole('button', { name: 'Attach' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Attach' })).toBeInTheDocument();
  });

  it('opens the one picker from the emoji button on Emoji, and from the GIF chip on GIF', async () => {
    const user = userEvent.setup();
    const view = render(<MessageInput channelId="ch1" guildId="g1" channelName="General" />);
    await user.click(screen.getByRole('button', { name: 'Emoji' }));
    const picker = await screen.findByRole('dialog');
    expect(within(picker).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Emoji', 'GIF', 'Stickers']);
    expect(within(picker).getByRole('tab', { name: 'Emoji' })).toHaveAttribute('aria-selected', 'true');
    expect(await within(picker).findByTestId('emoji-picker')).toBeInTheDocument();
    await user.click(within(picker).getByRole('tab', { name: 'Stickers' }));
    expect(await within(picker).findByTestId('sticker-picker')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    view.unmount();

    render(<MessageInput channelId="ch1" channelName="Mara" conversationKind="person" />);
    await chooseTool(user, 'GIF');
    const gif = await screen.findByRole('dialog');
    // No server, no stickers.
    expect(within(gif).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Emoji', 'GIF']);
    expect(within(gif).getByRole('tab', { name: 'GIF' })).toHaveAttribute('aria-selected', 'true');
    expect(await within(gif).findByTestId('gif-picker')).toBeInTheDocument();
  });

  it('completes # channels and : emoji in a listbox above the box; Enter puts it in', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'see #quick');
    const channels = screen.getByRole('listbox', { name: 'Channels' });
    expect(within(channels).getAllByRole('option').map((option) => option.textContent)).toEqual(['#quick-fire']);
    await user.keyboard('{Enter}');
    expect(textarea).toHaveValue('see <#chs> ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.type(textarea, ':fire');
    const emoji = await screen.findByRole('listbox', { name: 'Emoji' });
    // The server's own come first (fireball), then the common shortcodes.
    await waitFor(() => expect(within(emoji).getAllByRole('option')[0]).toHaveTextContent(':fireball:'));
    expect(within(emoji).getByRole('option', { name: /:fire:/ })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(textarea).toHaveValue('see <#chs> \u{1F525} ');
    // Escape closes a list without touching the words.
    await user.type(textarea, ':he');
    expect(screen.getByRole('listbox', { name: 'Emoji' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('see <#chs> \u{1F525} :he');
  });

  it('offers Send later and the scheduled list from a right-click on Send', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.listScheduledMessages).mockResolvedValue({ data: [] } as never);
    render(<MessageInput channelId="ch1" guildId="g1" channelName="General" />);
    await user.type(screen.getByRole('textbox'), 'later');
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: 'Send message' }) });
    const menu = await screen.findByRole('menu', { name: 'Send options' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Send later'), expect.stringContaining('Scheduled messages')]),
    );
    await user.click(within(menu).getByRole('menuitem', { name: /Scheduled messages/ }));
    expect(await screen.findByRole('dialog', { name: 'Scheduled messages' })).toBeInTheDocument();
    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
  });

  it('opens the same menu on a long press, and the press does not send', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<MessageInput channelId="ch1" guildId="g1" channelName="General" />);
      await user.type(screen.getByRole('textbox'), 'hold me');
      const send = screen.getByRole('button', { name: 'Send message' });
      fireEvent.pointerDown(send, { pointerType: 'touch' });
      await act(async () => { vi.advanceTimersByTime(520); });
      fireEvent.pointerUp(send, { pointerType: 'touch' });
      fireEvent.click(send);
      expect(await screen.findByRole('menu', { name: 'Send options' })).toBeInTheDocument();
      expect(mockSendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a scheduled message be canceled from its card', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="General" />);
    await user.type(screen.getByRole('textbox'), 'soon');
    await sendLater(user);
    expect(screen.getByLabelText(/Send at/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText(/Send at/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message General')).toHaveValue('soon');
  });

  it('replaces the box with one line in a channel this person cannot post in', () => {
    mockActionOverrides.send = { supported: true, allowed: false, reason: 'You do not have permission to use this action in this channel.' };
    const view = render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(root()).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByRole('status')).toHaveTextContent("You can't send messages in general");
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    view.unmount();
    render(<MessageInput channelId="cha" guildId="g1" channelName="announcements" />);
    expect(screen.getByRole('status')).toHaveTextContent('Only moderators can post in announcements');
  });

  it('keeps the box, with its route out, when the refusal is an encryption step this person can take', () => {
    mockEncryption.encrypted = true;
    mockEncryption.encryption = 'unlock';
    mockActionOverrides.send = { supported: true, allowed: false, reason: 'Unlock your encryption identity before sending in this conversation.' };
    render(<MemoryRouter><MessageInput channelId="ch1" channelName="Mara" conversationKind="person" /></MemoryRouter>);
    expect(root()).not.toHaveAttribute('data-read-only');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('says slow mode in the tools row', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="chs" guildId="g1" channelName="quick-fire" />);
    await user.click(screen.getByRole('textbox'));
    expect(screen.getByText('Slow mode: 12s')).toBeInTheDocument();
  });

  it('takes files dropped elsewhere for its conversation (stageComposerFiles)', async () => {
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    let staged = false;
    act(() => { staged = stageComposerFiles('ch1', [file]); });
    expect(staged).toBe(true);
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(root()).toHaveAttribute('data-ix-composer-open', 'true');
    expect(stageComposerFiles('nowhere', [file])).toBe(false);
  });
});

describe('the send flight, from the message box', () => {
  const said: Array<MotionEvents['say:sent']> = [];
  const settled: Array<MotionEvents['say:settled']> = [];
  let off: Array<() => void> = [];

  beforeEach(() => {
    said.length = 0;
    settled.length = 0;
    resetMotionBusForTests();
    resetMotionSwitchForTests();
    configureMotion('full');
    off = [onMotion('say:sent', (detail) => said.push(detail)), onMotion('say:settled', (detail) => settled.push(detail))];
    mockEncryption.encrypted = false; mockEncryption.encryption = 'ready';
    mockMessaging.runtimes.clear();
    localStorage.clear();
    mockOwner.serverId = '__local__';
    mockOwner.userId = 'u1';
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue(undefined);
    vi.mocked(channelApi.getFeatureSettings).mockImplementation(() => new Promise(() => {}));
    // jsdom lays nothing out; the words have to sit somewhere for there to be something to fly from.
    vi.spyOn(HTMLTextAreaElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 120, top: 800, width: 600, height: 36, right: 720, bottom: 836, x: 120, y: 800, toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    for (const stop of off) stop();
    vi.restoreAllMocks();
    resetMotionBusForTests();
    resetMotionSwitchForTests();
  });

  it('says where the words sit, on the keystroke, before the send is awaited; and hides the words behind the bubble', async () => {
    let finish: (() => void) | undefined;
    mockSendMessage.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general') as HTMLTextAreaElement;
    await user.type(textarea, 'count me in');
    await user.keyboard('{Enter}');
    // The gesture began without waiting for anything.
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ channelId: 'ch1', text: 'count me in', origin: { left: 120, top: 800, width: 600, height: 36 } });
    expect(said[0].origin?.inset).toBeTypeOf('number');
    // The real words are hidden, not removed: a failed send restores them by doing nothing.
    expect(textarea.style.opacity).toBe('0');
    expect(textarea).toHaveValue('count me in');
    expect(settled).toHaveLength(0);
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    finish?.();
    await waitFor(() => expect(settled).toHaveLength(1));
    // Accepted: the outbox owns delivery, the words are gone and the box is its own again.
    expect(settled[0]).toMatchObject({ channelId: 'ch1', nonce: said[0].nonce, ok: true });
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(textarea.style.opacity).toBe('');
  });

  it('gives the words back, and says the send did not go, when the send is refused', async () => {
    mockSendMessage.mockRejectedValue(new Error('This conversation is unavailable.'));
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general') as HTMLTextAreaElement;
    await user.type(textarea, 'no luck');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(settled).toHaveLength(1));
    expect(settled[0]).toMatchObject({ nonce: said[0].nonce, ok: false });
    expect(textarea).toHaveValue('no luck');
    expect(textarea.style.opacity).toBe('');
  });

  it('has no flight under reduced motion: no origin, and the draft stays put until it is answered', async () => {
    configureMotion('reduced');
    let finish: (() => void) | undefined;
    mockSendMessage.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general') as HTMLTextAreaElement;
    await user.type(textarea, 'quietly');
    await user.keyboard('{Enter}');
    expect(said).toHaveLength(1);
    expect(said[0].origin).toBeNull();
    expect(textarea.style.opacity).toBe('');
    expect(textarea).toHaveValue('quietly');
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    finish?.();
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('only plain text flies: a slash command and an empty box never begin it', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');
    await user.click(textarea);
    await user.keyboard('{Enter}');
    await user.type(textarea, '/roll 2d6');
    await user.keyboard('{Enter}');
    expect(said).toHaveLength(0);
  });

  it('carries the message being replied to, so the stand-in row has room for its chip', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" replyingTo={{ id: 'm9', author: 'Jeremy', content: 'movie night still on?' }} />);
    const textarea = screen.getByPlaceholderText(/Reply/);
    await user.type(textarea, 'yes');
    await user.keyboard('{Enter}');
    expect(said[0]).toMatchObject({ text: 'yes', replyToId: 'm9' });
  });

  it('lets the bubble go when the outbox cannot deliver an accepted send, and the card holds the words', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message general');
    await user.type(textarea, 'refused later');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(settled).toHaveLength(1));
    expect(settled[0].ok).toBe(true);
    // The outbox then reports the send failed: the watch lets go of the bubble.
    const runtime = [...mockMessaging.runtimes.values()][0];
    runtime.store.setState({
      queue: [{ source: 'local', record: { id: 'q1', channelId: 'ch1', status: 'failed', error: 'refused', refused: true, createdAt: new Date().toISOString(), draft: { revision: '1', content: 'refused later' } } }],
    } as never);
    await waitFor(() => expect(settled).toHaveLength(2), { timeout: 2_000 });
    expect(settled[1]).toMatchObject({ nonce: said[0].nonce, ok: false });
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
    ...mockEncryption,
    actions: { ...Object.fromEntries(['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map(action => [action, { supported: true, allowed: true, reason: null }])), ...mockActionOverrides },
    error: null, loading: false, refresh: vi.fn(),
  }),
}));
