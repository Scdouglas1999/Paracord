import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { botStoreApi } from '../../api/botStore';
import { botApi } from '../../api/bots';
import { toast } from '../../stores/toastStore';
import { BotStoreSection } from './BotStoreSection';

const mockState = vi.hoisted(() => ({
  guilds: [
    {
      id: 'guild-1',
      name: 'Release Guild',
      default_channel_id: 'channel-1',
      bot_settings: {},
    },
  ],
  channelsByGuild: {
    'guild-1': [
      {
        id: 'channel-1',
        name: 'general',
        type: 0,
        channel_type: 0,
      },
    ],
  },
  updateGuild: vi.fn(),
}));

vi.mock('../../stores/guildStore', () => ({
  useGuildStore: (selector: (state: { guilds: typeof mockState.guilds; updateGuild: typeof mockState.updateGuild }) => unknown) =>
    selector({ guilds: mockState.guilds, updateGuild: mockState.updateGuild }),
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: { channelsByGuild: typeof mockState.channelsByGuild }) => unknown) =>
    selector({ channelsByGuild: mockState.channelsByGuild }),
}));

vi.mock('../../api/botStore', () => ({
  botStoreApi: {
    search: vi.fn(),
  },
}));

vi.mock('../../api/bots', () => ({
  botApi: {
    addBotToGuild: vi.fn(),
  },
}));

vi.mock('../../api/client', () => ({
  extractApiError: vi.fn((err: { response?: { data?: { error?: string; message?: string } } }) =>
    err?.response?.data?.message || err?.response?.data?.error || 'request failed',
  ),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('./BotStoreCard', () => ({
  BotStoreCard: ({
    bot,
    onAdd,
    adding,
    canManage,
  }: {
    bot: { id: string; name: string };
    onAdd: (bot: { id: string; name: string }) => void;
    adding: boolean;
    canManage: boolean;
  }) => (
    <button type="button" disabled={!canManage || adding} onClick={() => onAdd(bot)}>
      {adding ? `Adding ${bot.name}` : `Add ${bot.name}`}
    </button>
  ),
}));

describe('BotStoreSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.guilds = [
      {
        id: 'guild-1',
        name: 'Release Guild',
        default_channel_id: 'channel-1',
        bot_settings: {},
      },
    ];
    mockState.updateGuild.mockResolvedValue(undefined);
    vi.mocked(botStoreApi.search).mockResolvedValue({ data: { bots: [] } } as never);
    vi.mocked(botApi.addBotToGuild).mockResolvedValue({ data: {} } as never);
  });

  it('shows a retryable public bot load error with API details', async () => {
    const user = userEvent.setup();
    vi.mocked(botStoreApi.search)
      .mockRejectedValueOnce({
        response: { data: { message: 'Public bot index is rebuilding.' } },
      })
      .mockResolvedValueOnce({
        data: {
          bots: [
            {
              id: 'bot-1',
              name: 'Deploy Helper',
            },
          ],
        },
      } as never);

    render(<BotStoreSection guildId="guild-1" canManage />);

    await user.click(screen.getByRole('button', { name: 'Public Store' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load public bots: Public bot index is rebuilding.',
    );

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Add Deploy Helper' })).toBeInTheDocument();
  });

  it('shows API details when built-in bot installation fails', async () => {
    const user = userEvent.setup();
    mockState.updateGuild.mockRejectedValueOnce({
      response: { data: { message: 'Bot settings are locked.' } },
    });

    render(<BotStoreSection guildId="guild-1" canManage />);

    await user.click(screen.getAllByRole('button', { name: /add to server/i })[0]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to install bot: Bot settings are locked.');
    });
  });

  it('shows API details when adding a public bot fails', async () => {
    const user = userEvent.setup();
    vi.mocked(botStoreApi.search).mockResolvedValueOnce({
      data: {
        bots: [
          {
            id: 'bot-1',
            name: 'Deploy Helper',
          },
        ],
      },
    } as never);
    vi.mocked(botApi.addBotToGuild).mockRejectedValueOnce({
      response: { data: { message: 'Missing Manage Guild permission.' } },
    });

    render(<BotStoreSection guildId="guild-1" canManage />);

    await user.click(screen.getByRole('button', { name: 'Public Store' }));
    await user.click(await screen.findByRole('button', { name: 'Add Deploy Helper' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to add Deploy Helper: Missing Manage Guild permission.',
      );
    });
  });
});
