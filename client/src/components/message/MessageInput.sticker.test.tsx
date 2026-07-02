import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guildApi } from '../../api/guilds';
import { MessageInput } from './MessageInput';

const mockSendMessage = vi.fn();

vi.mock('../../stores/messageStore', () => ({
  useMessageStore: Object.assign(
    () => ({}),
    {
      getState: () => ({
        sendMessage: mockSendMessage,
        addMessage: vi.fn(),
      }),
    },
  ),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (s: unknown) => unknown) =>
    selector({
      channelsByGuild: {
        g1: [{ id: 'ch1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 }],
      },
    }),
}));

vi.mock('../../stores/memberStore', () => ({
  useMemberStore: (selector: (s: unknown) => unknown) => selector({ members: new Map() }),
}));

vi.mock('../../stores/pollStore', () => ({
  usePollStore: {
    getState: () => ({
      upsertPoll: vi.fn(),
    }),
  },
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../hooks/useFileUpload', () => ({
  useFileUpload: () => ({ upload: vi.fn(), uploading: false }),
}));

vi.mock('../../hooks/useTyping', () => ({
  useTyping: () => ({ triggerTyping: vi.fn() }),
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    createPoll: vi.fn(),
    getFeatureSettings: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock('../../api/guilds', () => ({
  guildApi: {
    listStickers: vi.fn(),
  },
}));

vi.mock('../../lib/apiBaseUrl', () => ({
  resolveApiBaseUrl: () => '/api/v1',
  resolveResourceUrl: (url: string) => url,
}));

vi.mock('../../lib/authToken', () => ({
  getAccessToken: () => 'test-token',
}));

vi.mock('../ui/EmojiPicker', () => ({
  EmojiPicker: () => null,
}));

vi.mock('./GifPicker', () => ({
  GifPicker: ({ onSelect }: { onSelect: (url: string) => void }) => (
    <button type="button" onClick={() => onSelect('https://cdn.example.com/reaction.gif')}>
      Select GIF
    </button>
  ),
}));

vi.mock('./MarkdownToolbar', () => ({
  MarkdownToolbar: () => null,
  applyMarkdownToolbarAction: vi.fn(),
  resolveMarkdownShortcut: vi.fn(() => null),
}));

vi.mock('./SlashCommandPopup', () => ({
  SlashCommandPopup: () => null,
}));

vi.mock('../../lib/constants', () => ({
  MAX_MESSAGE_LENGTH: 2000,
}));

const listStickers = vi.mocked(guildApi.listStickers);
const stickerResponse = (data: Awaited<ReturnType<typeof guildApi.listStickers>>['data']) =>
  ({ data }) as Awaited<ReturnType<typeof guildApi.listStickers>>;

describe('MessageInput sticker flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue(undefined);
    listStickers.mockResolvedValue(
      stickerResponse([
        {
          id: '1001',
          guild_id: 'g1',
          name: 'ship_it',
          description: null,
          format_type: 1,
          creator_id: null,
          image_url: null,
          created_at: '2026-05-17T00:00:00Z',
        },
      ]),
    );
  });

  it('sends a selected sticker as a sticker-only message', async () => {
    const user = userEvent.setup();

    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);

    await user.click(screen.getByRole('button', { name: 'Stickers' }));
    await user.click(await screen.findByRole('button', { name: 'Select sticker ship_it' }));

    expect(mockSendMessage).toHaveBeenCalledWith('ch1', '', undefined, undefined, ['1001']);
  });

  it('shows API detail when sending a selected sticker fails', async () => {
    const user = userEvent.setup();
    mockSendMessage.mockRejectedValue({
      response: { data: { message: 'Sticker use is blocked in this channel.' } },
    });

    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);

    await user.click(screen.getByRole('button', { name: 'Stickers' }));
    await user.click(await screen.findByRole('button', { name: 'Select sticker ship_it' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to send sticker: Sticker use is blocked in this channel.',
    );
  });

  it('shows API detail when sending a selected GIF fails', async () => {
    const user = userEvent.setup();
    mockSendMessage.mockRejectedValue({
      response: { data: { message: 'GIF links are disabled in this channel.' } },
    });

    render(<MessageInput channelId="ch1" guildId="g1" channelName="general" />);

    await user.click(screen.getByRole('button', { name: 'GIF' }));
    await user.click(await screen.findByRole('button', { name: 'Select GIF' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to send GIF: GIF links are disabled in this channel.',
    );
  });
});
