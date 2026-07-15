import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForumView } from './ForumView';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getForumPosts: vi.fn(),
  getForumTags: vi.fn(),
  searchMessages: vi.fn(),
  createForumPost: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    useParams: () => ({ guildId: 'guild-1' }),
  };
});

vi.mock('../../api/client', () => ({
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'Unexpected failure'),
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    getForumPosts: mocks.getForumPosts,
    getForumTags: mocks.getForumTags,
    updateForumSortOrder: vi.fn(),
    searchMessages: mocks.searchMessages,
    createForumTag: vi.fn(),
    deleteForumTag: vi.fn(),
    createForumPost: mocks.createForumPost,
  },
}));

vi.mock('../../stores/memberStore', () => ({
  useMemberStore: (selector: (state: unknown) => unknown) =>
    selector({
      members: new Map([['guild-1', []]]),
      membersLoaded: { 'guild-1': true },
      fetchMembers: vi.fn(),
    }),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: 1n << 4n, // MANAGE_CHANNELS
    isAdmin: false,
    isOwner: false,
    isLoading: false,
  }),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: vi.fn(),
    error: mocks.toastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

describe('ForumView tag accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getForumPosts.mockResolvedValue({
      data: {
        posts: [],
        tags: [
          { id: 'tag-1', name: 'Alpha', emoji: null },
          { id: 'tag-2', name: 'Beta', emoji: null },
        ],
      },
    });
    mocks.getForumTags.mockResolvedValue({
      data: [
        { id: 'tag-1', name: 'Alpha', emoji: null },
        { id: 'tag-2', name: 'Beta', emoji: null },
      ],
    });
    mocks.searchMessages.mockResolvedValue({ data: [] });
    mocks.createForumPost.mockResolvedValue({ data: { id: 'post-1' } });
  });

  it('supports Arrow/Home/End keyboard navigation for filter tags', async () => {
    render(<ForumView channelId="channel-1" channelName="forum" />);

    const alpha = await screen.findByRole('button', { name: 'Alpha' });
    const beta = await screen.findByRole('button', { name: 'Beta' });

    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(beta).toHaveFocus();

    fireEvent.keyDown(beta, { key: 'Home' });
    expect(alpha).toHaveFocus();

    fireEvent.keyDown(alpha, { key: 'End' });
    expect(beta).toHaveFocus();
  });

  it('preserves forum search error details in feedback', async () => {
    const user = userEvent.setup();
    mocks.searchMessages.mockRejectedValueOnce(new Error('Search backend unavailable'));

    render(<ForumView channelId="channel-1" channelName="forum" />);

    const search = await screen.findByPlaceholderText('Search posts…');
    await user.type(search, 'release{Enter}');

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('Search failed: Search backend unavailable');
    });
  });

  it('navigates to the matching post when a search result is clicked', async () => {
    const user = userEvent.setup();
    mocks.searchMessages.mockResolvedValueOnce({
      data: [
        {
          id: 'msg-9',
          channel_id: 'post-thread-1',
          content: 'Ship the release notes',
          created_at: '2026-07-01T12:00:00.000Z',
          author: { id: 'u1', username: 'Sam' },
        },
      ],
    });

    render(<ForumView channelId="channel-1" channelName="forum" />);

    const search = await screen.findByPlaceholderText('Search posts…');
    await user.type(search, 'release{Enter}');

    await user.click(await screen.findByRole('button', { name: /Ship the release notes/i }));

    expect(mocks.navigate).toHaveBeenCalledWith(
      '/app/guilds/guild-1/channels/post-thread-1?message=msg-9',
    );
  });

  it('ignores stale search responses when a newer query finishes first', async () => {
    const user = userEvent.setup();
    let resolveSlow: ((value: { data: unknown[] }) => void) | undefined;
    mocks.searchMessages
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce({
        data: [
          {
            id: 'msg-fast',
            channel_id: 'post-2',
            content: 'fast hit',
            author: { id: 'u1', username: 'Sam' },
          },
        ],
      });

    render(<ForumView channelId="channel-1" channelName="forum" />);
    const search = await screen.findByPlaceholderText('Search posts…');

    await user.type(search, 'slow{Enter}');
    await user.clear(search);
    await user.type(search, 'fast{Enter}');

    await screen.findByRole('button', { name: /fast hit/i });
    resolveSlow?.({
      data: [
        {
          id: 'msg-slow',
          channel_id: 'post-1',
          content: 'slow hit',
          author: { id: 'u1', username: 'Sam' },
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /fast hit/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /slow hit/i })).not.toBeInTheDocument();
  });

  it('preserves create-post error details in feedback', async () => {
    const user = userEvent.setup();
    mocks.createForumPost.mockRejectedValueOnce(new Error('Title contains blocked markup'));

    render(<ForumView channelId="channel-1" channelName="forum" />);

    await user.click(await screen.findByRole('button', { name: 'New Post' }));
    await user.type(screen.getByPlaceholderText("What's this discussion about?"), 'Bad post');
    await user.click(screen.getByRole('button', { name: 'Create Post' }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Failed to create post: Title contains blocked markup',
      );
    });
  });

  it('gives the opening message the shared markdown formatting controls', async () => {
    const user = userEvent.setup();
    render(<ForumView channelId="channel-1" channelName="forum" />);

    await user.click(await screen.findByRole('button', { name: 'New Post' }));
    const content = screen.getByRole('textbox', { name: 'Opening message (optional)' });
    await user.type(content, 'Launch notes');
    (content as HTMLTextAreaElement).setSelectionRange(0, 'Launch notes'.length);
    await user.click(screen.getByRole('button', { name: /Bold/i }));

    expect(content).toHaveValue('**Launch notes**');
    expect(screen.getByText('16/2000')).toBeInTheDocument();
    expect(screen.getByText(/Markdown formatting is supported/i)).toBeInTheDocument();
  });
});
