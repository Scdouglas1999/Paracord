import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';
import { ThreadPanel } from './ThreadPanel';

const mockState = vi.hoisted(() => ({
  channelsByGuild: {
    'guild-1': [
      {
        id: 'thread-1',
        parent_id: 'parent-1',
        thread_metadata: { archived: true },
      },
    ],
  },
  updateChannel: vi.fn(),
  removeChannel: vi.fn(),
}));

vi.mock('../../stores/channelStore', () => {
  const useChannelStore = (selector: (state: { channelsByGuild: typeof mockState.channelsByGuild }) => unknown) =>
    selector({ channelsByGuild: mockState.channelsByGuild });
  useChannelStore.getState = () => ({
    updateChannel: mockState.updateChannel,
    removeChannel: mockState.removeChannel,
  });
  return { useChannelStore };
});

vi.mock('../../api/channels', () => ({
  channelApi: {
    deleteThread: vi.fn(),
    updateThread: vi.fn(),
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
  },
}));

vi.mock('../../stores/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('./MessageList', () => ({
  MessageList: () => <div>Message history</div>,
}));

vi.mock('./MessageInput', () => ({
  MessageInput: () => <div>Message composer</div>,
}));

describe('ThreadPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.channelsByGuild = {
      'guild-1': [
        {
          id: 'thread-1',
          parent_id: 'parent-1',
          thread_metadata: { archived: true },
        },
      ],
    };
  });

  it('shows API details when restoring an archived thread fails', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.updateThread).mockRejectedValueOnce({
      response: { data: { message: 'Thread archive lock is still active.' } },
    });

    render(
      <ThreadPanel
        guildId="guild-1"
        threadChannelId="thread-1"
        threadName="Release thread"
        parentChannelName="general"
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to restore thread: Thread archive lock is still active.',
      );
    });
  });

  it('shows API details when deleting a thread fails', async () => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(channelApi.deleteThread).mockRejectedValueOnce({
      response: { data: { message: 'Thread has retained audit evidence.' } },
    });

    render(
      <ThreadPanel
        guildId="guild-1"
        threadChannelId="thread-1"
        threadName="Release thread"
        parentChannelName="general"
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to delete thread: Thread has retained audit evidence.',
      );
    });
  });
});
