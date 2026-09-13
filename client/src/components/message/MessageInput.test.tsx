vi.mock('../../lib/channelView', () => ({ getAccountChannelView: (_scope: unknown, state: unknown) => state }));
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { channelApi } from '../../api/channels';
import { MessageInput } from './MessageInput';

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
        channelsByGuild: { g1: [{ id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 }] },
        channelsById: { ch1: { id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 } },
      }),
    {
      getState: () => ({
        channelsByGuild: { g1: [{ id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 }] },
        channelsById: { ch1: { id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 } },
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
  useTyping: () => ({ triggerTyping: vi.fn() }),
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    createPoll: vi.fn(),
    getFeatureSettings: vi.fn(() => new Promise(() => {})),
    getOverwrites: vi.fn(() => Promise.resolve({ data: [] })),
  },
}));

vi.mock('./MarkdownToolbar', () => ({
  MarkdownToolbar: () => null,
  applyMarkdownToolbarAction: vi.fn(),
  resolveMarkdownShortcut: vi.fn(() => null),
}));

vi.mock('../ui/EmojiPicker', () => ({
  EmojiPicker: () => null,
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
    mockActionOverrides.send = { supported: true, allowed: false, reason: 'Set up encryption before sending this direct message.' };
    render(<MemoryRouter><MessageInput channelId="ch1" channelName="Alice" /></MemoryRouter>);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'Keep this private draft');
    const link = screen.getByRole('link', { name: 'Set up encryption' });
    const destination = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(destination.pathname).toBe('/setup');
    expect(destination.searchParams.get('server')).toBe(mockOwner.serverId);
    expect(destination.searchParams.get('user')).toBe(mockOwner.userId);
    expect(input).toHaveValue('Keep this private draft');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('renders a textarea with channel placeholder', () => {
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message #general');
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  it('renders with default placeholder when no channel name', () => {
    render(<MessageInput channelId="ch1" guildId="g1" />);
    expect(screen.getByPlaceholderText('Message this channel')).toBeInTheDocument();
  });

  it('allows typing in the textarea', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message #general');

    await user.type(textarea, 'Hello world');
    expect(textarea).toHaveValue('Hello world');
  });

  it('sends message on Enter key', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message #general');

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
    const textarea = screen.getByPlaceholderText('Message #general');

    await user.type(textarea, 'Line 1');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('does not send empty message', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message #general');

    await user.click(textarea);
    await user.keyboard('{Enter}');

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('clears textarea after successful send', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message #general');

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
    const textarea = screen.getByPlaceholderText('Message #general');
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
    await user.type(screen.getByPlaceholderText('Message #general'), 'private A');
    await user.click(screen.getByRole('button', { name: 'Create a poll' }));
    mockOwner.serverId = 'b';
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByPlaceholderText('Message #general')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Poll composer enabled' })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Message #general'), 'private B');
    mockOwner.serverId = '__local__';
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByPlaceholderText('Message #general')).toHaveValue('private A');
    mockOwner.serverId = 'b';
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByPlaceholderText('Message #general')).toHaveValue('private B');
  });

  it('preserves typing during delivery and does not cancel another composer reply', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    mockSendMessage.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const cancelReply = vi.fn();
    const view = render(<MessageInput channelId="ch1" channelName="general" onCancelReply={cancelReply} />);
    await user.type(screen.getByPlaceholderText('Message #general'), 'first');
    await user.keyboard('{Enter}');
    await user.type(screen.getByPlaceholderText('Message #general'), ' second');
    view.rerender(<MessageInput channelId="ch2" channelName="next" onCancelReply={cancelReply} />);
    await user.type(screen.getByPlaceholderText('Message #next'), 'other channel');
    await act(async () => resolve());
    expect(screen.getByPlaceholderText('Message #next')).toHaveValue('other channel');
    expect(cancelReply).not.toHaveBeenCalled();
    view.rerender(<MessageInput channelId="ch1" channelName="general" onCancelReply={cancelReply} />);
    expect(screen.getByPlaceholderText('Message #general')).toHaveValue('first second');
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
    const textarea = screen.getByPlaceholderText('Message #general');
    await user.type(textarea, 'Should we ship?');
    await user.click(screen.getByRole('button', { name: 'Create a poll' }));
    expect(textarea).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Poll composer enabled' }));
    expect(textarea).toHaveValue('Should we ship?');
  });

  it('explains unsupported encrypted DM polls without opening the composer', async () => {
    const user = userEvent.setup();
    mockActionOverrides.poll = { supported: false, allowed: false, reason: 'Polls are not available in encrypted direct messages.' };
    render(<MessageInput channelId="ch1" channelName="friend" />);
    expect(screen.queryByRole('button', { name: 'Create a poll' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More message tools' }));
    const item = screen.getByRole('menuitem', { name: /Create a poll/ });
    expect(item).toBeDisabled();
    expect(screen.getByText('Polls are not available in encrypted direct messages.')).toBeInTheDocument();
    await user.click(item);
    expect(screen.queryByPlaceholderText('What should everyone weigh in on?')).not.toBeInTheDocument();
  });

  it('retains a completed poll after permission is revoked and prevents submission', async () => {
    const user = userEvent.setup();
    const view = render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    await user.click(screen.getByRole('button', { name: 'Create a poll' }));
    await user.type(screen.getByPlaceholderText('What should everyone weigh in on?'), 'Lunch?');
    await user.type(screen.getByPlaceholderText('Option 1'), 'Soup');
    await user.type(screen.getByPlaceholderText('Option 2'), 'Salad');
    mockActionOverrides.poll = { supported: true, allowed: false, reason: 'Permission removed.' };
    view.rerender(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByPlaceholderText('What should everyone weigh in on?')).toHaveValue('Lunch?');
    expect(screen.getByPlaceholderText('Option 1')).toHaveValue('Soup');
    expect(screen.getByPlaceholderText('Option 2')).toHaveValue('Salad');
    expect(screen.getByRole('status')).toHaveTextContent('Permission removed.');
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
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled();
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

  it('shows reply indicator when replyingTo is provided', () => {
    render(
      <MessageInput
        channelId="ch1"
        guildId="g1"
        channelName="general"
        replyingTo={{ id: 'm1', author: 'TestUser', content: 'Original message' }}
        onCancelReply={vi.fn()}
      />,
    );

    expect(screen.getByText('Replying to')).toBeInTheDocument();
    expect(screen.getByText('TestUser')).toBeInTheDocument();
    expect(screen.getByText('Original message')).toBeInTheDocument();
  });

  it('shows send button when content is typed', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const textarea = screen.getByPlaceholderText('Message #general');

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

    await user.type(screen.getByPlaceholderText('Message #general'), 'Too fast');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Slowmode active. Try again in 10 seconds.')).toBeInTheDocument();
  });

  it('previews selected files, uploads them, and sends attachment ids', async () => {
    const user = userEvent.setup();
    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);
    const file = new File(['png'], 'release.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, file);

    expect(screen.getByAltText('release.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove release.png' })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Message #general'), 'with upload');
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
    await user.type(screen.getByPlaceholderText('Message #general'), 'private file');
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

    await user.click(screen.getByRole('button', { name: 'Schedule message' }));
    await user.type(screen.getByPlaceholderText('Schedule message for #general'), 'Standup reminder');
    await user.type(screen.getByLabelText(/Send At/), scheduledAt);

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

    await user.click(screen.getByRole('button', { name: 'Schedule message' }));
    const textarea = screen.getByPlaceholderText('Schedule message for #general');
    await user.type(textarea, 'Too soon');
    await user.type(screen.getByLabelText(/Send At/), scheduledAt);
    await user.click(screen.getByRole('button', { name: 'Schedule message' }));

    expect(await screen.findByText('Scheduled time must be in the future.')).toBeInTheDocument();
    expect(textarea).toHaveValue('Too soon');
    expect(screen.getByLabelText(/Send At/)).toHaveValue(scheduledAt);
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

    await user.click(screen.getByRole('button', { name: 'Schedule message' }));
    await user.type(screen.getByPlaceholderText('Schedule message for #general'), 'Too late');
    await user.type(screen.getByLabelText(/Send At/), pastScheduledAt);
    await user.click(screen.getByRole('button', { name: 'Schedule message' }));

    expect(await screen.findByText('Choose a time at least 5 seconds in the future.')).toBeInTheDocument();
    expect(mockScheduleMessage).not.toHaveBeenCalled();
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
