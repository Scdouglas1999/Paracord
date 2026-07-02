import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { channelApi } from '../../api/channels';
import { MessageInput } from './MessageInput';

// Mock stores
const mockSendMessage = vi.fn();
const mockScheduleMessage = vi.fn();
const mockAddMessage = vi.fn();
const mockUpload = vi.fn();
const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
}));
vi.mock('../../stores/messageStore', () => ({
  useMessageStore: Object.assign(
    () => ({}),
    {
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
      selector({ channelsByGuild: { g1: [{ id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 }] } }),
    {
      getState: () => ({
        channelsByGuild: { g1: [{ id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 }] },
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

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: mockToast.success,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../hooks/useFileUpload', () => ({
  useFileUpload: () => ({ upload: mockUpload, uploading: false }),
}));

vi.mock('../../hooks/useTyping', () => ({
  useTyping: () => ({ triggerTyping: vi.fn() }),
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    createPoll: vi.fn(),
    getFeatureSettings: vi.fn(() => new Promise(() => {})),
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

    expect(mockSendMessage).toHaveBeenCalledWith('ch1', 'Hello', undefined, []);
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
    expect(mockSendMessage).toHaveBeenCalledWith('ch1', 'with upload', undefined, ['attachment-1']);
    expect(screen.queryByAltText('release.png')).not.toBeInTheDocument();
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

    expect(await screen.findByText('Choose a future time for scheduled messages.')).toBeInTheDocument();
    expect(mockScheduleMessage).not.toHaveBeenCalled();
  });
});
