import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../api/channels';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';
import { ThreadPanel } from './ThreadPanel';

const mockState = vi.hoisted(() => ({
  permissions: 1n << 4n,
  channelsByGuild: {
    'guild-1': [
      {
        id: 'thread-1',
        parent_id: 'parent-1',
        thread_metadata: { archived: true },
      },
    ],
  },
  channelsById: {
    'thread-1': {
      id: 'thread-1',
      parent_id: 'parent-1',
      owner_id: 'viewer',
      thread_metadata: { archived: true },
    },
  } as Record<
    string,
    {
      id: string;
      parent_id: string;
      owner_id: string;
      thread_metadata: { archived: boolean };
    }
  >,
  updateChannel: vi.fn(),
  removeChannel: vi.fn(),
  selectChannel: vi.fn(),
}));

vi.mock('../../stores/channelStore', () => {
  const useChannelStore = (selector: (state: typeof mockState) => unknown) =>
    selector(mockState);
  useChannelStore.getState = () => ({
    updateChannel: mockState.updateChannel,
    removeChannel: mockState.removeChannel,
    selectChannel: mockState.selectChannel,
  });
  return { useChannelStore };
});

vi.mock('../../api/channels', () => ({
  channelApi: {
    deleteThread: vi.fn(),
    updateThread: vi.fn(),
  },
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'viewer' } }),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: mockState.permissions, isAdmin: false }),
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
  MessageList: ({
    onReply,
  }: {
    onReply?: (msg: {
      id: string;
      author: { id: string; username: string };
      content: string;
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onReply?.({
          id: 'msg-1',
          author: { id: 'u1', username: 'Alice' },
          content: 'Original thread message',
        })
      }
    >
      Reply in thread
    </button>
  ),
}));

vi.mock('./MessageInput', () => ({
  MessageInput: ({
    replyingTo,
    onCancelReply,
  }: {
    replyingTo?: { id: string; author: string; content: string } | null;
    onCancelReply?: () => void;
  }) => (
    <div>
      <div>{replyingTo ? `Replying to ${replyingTo.author}` : 'Message composer'}</div>
      {replyingTo && (
        <button type="button" onClick={() => onCancelReply?.()}>
          Cancel reply
        </button>
      )}
    </div>
  ),
}));

describe('ThreadPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.permissions = 1n << 4n;
    mockState.channelsByGuild = {
      'guild-1': [
        {
          id: 'thread-1',
          parent_id: 'parent-1',
          thread_metadata: { archived: true },
        },
      ],
    };
    mockState.channelsById = {
      'thread-1': {
        id: 'thread-1',
        parent_id: 'parent-1',
        owner_id: 'viewer',
        thread_metadata: { archived: true },
      },
    };
  });

  it('shows API details when restoring an archived thread fails', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.updateThread).mockRejectedValueOnce({
      response: { data: { message: 'Thread archive lock is still active.' } },
    });

    renderThreadPanel(
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

    renderThreadPanel(
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

  it('hides destructive controls from a thread owner without channel-management access', () => {
    mockState.permissions = 0n;

    renderThreadPanel(
      <ThreadPanel
        guildId="guild-1"
        threadChannelId="thread-1"
        threadName="Release thread"
        parentChannelName="general"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('uses the parent breadcrumb to return to the parent conversation', async () => {
    const user = userEvent.setup();
    renderThreadPanel(
      <ThreadPanel
        guildId="guild-1"
        threadChannelId="thread-1"
        threadName="Release thread"
        parentChannelName="general"
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Open parent channel general' }));

    expect(mockState.selectChannel).toHaveBeenCalledWith('parent-1');
    expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/guild-1/channels/parent-1');
  });

  it('clears the reply bar when switching to another thread', async () => {
    const user = userEvent.setup();
    mockState.channelsById = {
      'thread-1': {
        id: 'thread-1',
        parent_id: 'parent-1',
        owner_id: 'viewer',
        thread_metadata: { archived: false },
      },
      'thread-2': {
        id: 'thread-2',
        parent_id: 'parent-1',
        owner_id: 'viewer',
        thread_metadata: { archived: false },
      },
    };

    const { rerender } = renderThreadPanel(
      <ThreadPanel
        guildId="guild-1"
        threadChannelId="thread-1"
        threadName="Release thread"
        parentChannelName="general"
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Reply in thread' }));
    expect(screen.getByText('Replying to Alice')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ThreadPanel
          guildId="guild-1"
          threadChannelId="thread-2"
          threadName="Other thread"
          parentChannelName="general"
          onClose={vi.fn()}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(screen.getByText('Message composer')).toBeInTheDocument();
    expect(screen.queryByText('Replying to Alice')).not.toBeInTheDocument();
  });
});

function renderThreadPanel(panel: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/channels/thread-1']}>
      {panel}
      <LocationProbe />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}
