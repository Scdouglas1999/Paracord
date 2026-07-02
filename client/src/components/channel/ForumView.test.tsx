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

    const search = await screen.findByPlaceholderText('Search posts...');
    await user.type(search, 'release{Enter}');

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('Search failed: Search backend unavailable');
    });
  });

  it('preserves create-post error details in feedback', async () => {
    const user = userEvent.setup();
    mocks.createForumPost.mockRejectedValueOnce(new Error('Title contains blocked markup'));

    render(<ForumView channelId="channel-1" channelName="forum" />);

    await user.click(await screen.findByRole('button', { name: 'New Post' }));
    await user.type(screen.getByPlaceholderText('Post title'), 'Bad post');
    await user.click(screen.getByRole('button', { name: 'Create Post' }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Failed to create post: Title contains blocked markup',
      );
    });
  });
});
