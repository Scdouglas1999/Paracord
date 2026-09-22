import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeNeedsYou, homeAttention, needsYouReason } from './HomeNeedsYou';
import { useReadStateStore } from '../../stores/readStateStore';
import { captureScopedOperation } from '../../lib/operationContext';
import type { ConversationEntry } from '../../lib/attention/conversationModel';
import type { FriendRequestEntry } from '../../hooks/useUnifiedConversations';
import {
  acceptDatabaseHistoryEpoch,
  clearDatabaseHistoryMemory,
  registerHistoryReconciler,
} from '../../lib/databaseHistory';

vi.mock('../../lib/operationContext', () => ({ captureScopedOperation: vi.fn() }));

const request = vi.fn();
const dispose = vi.fn();

function entry(id: string, overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  const scope = overrides.scope ?? { serverId: 'a', userId: 'user' };
  return {
    scope,
    serverId: scope.serverId,
    key: JSON.stringify([scope.serverId, scope.userId, id]),
    channelId: id,
    guildId: 'space',
    kind: 'guild_text',
    title: id,
    contextLabel: 'Workshop',
    lastActivityId: '100',
    unread: true,
    mentionCount: 0,
    isDMUnread: false,
    isThreadReply: false,
    hasVoiceActivity: false,
    pinned: false,
    ...overrides,
  };
}

function response(message: unknown, channel = 'chat', user = 'user', kind = 'unread') {
  return { data: { channel_id: channel, user_id: user, kind, message } };
}
function message(channel = 'chat', content = 'The build is ready') {
  return {
    id: '100',
    channel_id: channel,
    content,
    author: { id: 'ada', username: 'Ada' },
    attachments: [],
  };
}

/** The section's required props, so a case only states what it is about. */
function shell(props: Partial<React.ComponentProps<typeof HomeNeedsYou>> = {}) {
  return {
    entries: [],
    requests: [] as FriendRequestEntry[],
    status: 'ready' as const,
    onOpen: vi.fn(),
    onAccept: vi.fn(),
    onRefresh: vi.fn(),
    ...props,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearDatabaseHistoryMemory();
  useReadStateStore.setState({ byAccount: {}, attentionRevisions: {} });
  vi.mocked(captureScopedOperation).mockImplementation(
    (scope) =>
      ({ request: (config: unknown) => request({ ...(config as object), scope }), dispose }) as never,
  );
  request.mockImplementation(
    ({ url, params, scope }: { url: string; params: { kind: string }; scope: { userId: string } }) =>
      Promise.resolve(
        response(message(url.split('/')[2]), url.split('/')[2], scope.userId, params.kind),
      ),
  );
});

describe('the reason a row is here', () => {
  it('names the author of a mention, and never says you mentioned yourself', () => {
    expect(needsYouReason(entry('chat', { mentionCount: 2 }), 'Priya')).toBe('Priya mentioned you');
    expect(needsYouReason(entry('chat', { mentionCount: 2 }), null)).toBe('2 mentions for you');
    expect(needsYouReason(entry('chat', { mentionCount: 1 }), null)).toBe('1 mention for you');
  });

  it('says what kind of waiting each other row is', () => {
    expect(needsYouReason(entry('Ren', { unread: false, isDMUnread: true, kind: 'dm' }), null)).toBe('Ren');
    expect(needsYouReason(entry('build-log', { unread: false, isThreadReply: true }), null)).toBe(
      'New replies in build-log',
    );
    expect(needsYouReason(entry('build-log'), null)).toBe('New in build-log');
    expect(
      needsYouReason(entry('Shop floor', { unread: false, hasVoiceActivity: true }), null),
    ).toBe('Activity in Shop floor');
  });
});

describe('Home attention', () => {
  it('keeps Home available when history metadata is corrupt and waits for a valid reconnect', async () => {
    localStorage.setItem('paracord:database-history:["a","user"]', 'corrupt');
    const reconcile = vi.fn();
    const unsubscribe = registerHistoryReconciler(reconcile);
    try {
      render(<HomeNeedsYou {...shell({ entries: [entry('chat')] })} />);
      expect(screen.getByText(/Reconnect this account to restore previews/)).toBeVisible();
      expect(captureScopedOperation).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Reconnect to load preview for chat' }));
      expect(reconcile).toHaveBeenCalledWith(entry('chat').scope);
      expect(request).not.toHaveBeenCalled();
      act(() => {
        acceptDatabaseHistoryEpoch(entry('chat').scope, '7257b8f7-610e-4a8b-a20c-5a94a7b98428');
      });
      expect(await screen.findByText(/Ada: The build is ready/)).toBeVisible();
    } finally {
      unsubscribe();
    }
  });

  it('reserves attention for direct replies, deduplicates pinned entries, and keeps their ranking', () => {
    const pinned = entry('pinned', { pinned: true, mentionCount: 1 });
    const dm = entry('dm', { unread: false, isDMUnread: true });
    const thread = entry('thread', { unread: false, isThreadReply: true });
    const voice = entry('voice', { unread: false, hasVoiceActivity: true });
    const read = entry('read', { unread: false });
    expect(
      homeAttention([voice, read, thread, dm, pinned, pinned, entry('plain')]).map((row) => row.title),
    ).toEqual(['pinned', 'dm', 'thread']);
  });

  it('shows the reason and the server, and opens the conversation the row owns', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const first = entry('chat', { mentionCount: 2 });
    const second = entry('chat', {
      scope: { serverId: 'b', userId: 'other' },
      title: 'second',
      unread: false,
      isThreadReply: true,
      contextLabel: 'Saltmarsh',
    });
    render(<HomeNeedsYou {...shell({ entries: [first, second], onOpen })} />);
    // The mention row names its author and drops the redundant "Ada:" prefix.
    expect(await screen.findByText('Ada mentioned you')).toBeInTheDocument();
    expect(screen.getByText('chat · The build is ready')).toBeInTheDocument();
    expect(screen.getByText('New replies in second')).toBeInTheDocument();
    expect(screen.getByText(/^Saltmarsh · Ada: The build is ready$/)).toBeInTheDocument();
    expect(captureScopedOperation).toHaveBeenCalledWith(second.scope);
    await user.click(screen.getByRole('button', { name: 'Open second' }));
    expect(onOpen).toHaveBeenCalledWith(second, '100');
  });

  it('falls back to the count when the mention author is the reader', async () => {
    request.mockResolvedValue(
      response({ ...message('chat'), author: { id: 'user', username: 'You' } }, 'chat', 'user', 'mention'),
    );
    render(<HomeNeedsYou {...shell({ entries: [entry('chat', { mentionCount: 2 })] })} />);
    expect(await screen.findByText('2 mentions for you')).toBeInTheDocument();
    expect(screen.queryByText(/You mentioned you/)).not.toBeInTheDocument();
  });

  it('offers Reply on a direct message and Open everywhere else', async () => {
    render(
      <HomeNeedsYou
        {...shell({
          entries: [
            entry('Ren', { kind: 'dm', unread: false, isDMUnread: true, contextLabel: null, userId: '9' }),
            entry('build-log'),
          ],
        })}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Reply Ren' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open build-log' })).toBeInTheDocument();
  });

  it('does not show encrypted content or attachment metadata', async () => {
    request.mockResolvedValue(
      response({
        ...message('chat', 'secret plaintext'),
        e2ee: { ciphertext: 'cipher' },
        attachments: [{ filename: 'secret.png' }],
      }),
    );
    render(<HomeNeedsYou {...shell({ entries: [entry('chat')] })} />);
    expect(await screen.findByText(/Encrypted message — open/)).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it('rejects a preview from a different channel and provides retry', async () => {
    request.mockResolvedValueOnce(response(message('wrong', 'Wrong account text')));
    render(<HomeNeedsYou {...shell({ entries: [entry('chat')] })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry preview for chat' }));
    expect(await screen.findByText(/Ada: The build is ready/)).toBeInTheDocument();
    expect(screen.queryByText(/Wrong account text/)).not.toBeInTheDocument();
  });

  it('disposes old requests and ignores a late response after the activity changes', async () => {
    let resolve!: (value: unknown) => void;
    request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { rerender, unmount } = render(<HomeNeedsYou {...shell({ entries: [entry('chat')] })} />);
    rerender(<HomeNeedsYou {...shell({ entries: [entry('chat', { lastActivityId: '101' })] })} />);
    expect(await screen.findByText(/Ada: The build is ready/)).toBeInTheDocument();
    await act(async () => resolve(response(message('chat', 'stale reply'))));
    expect(screen.queryByText(/stale reply/)).not.toBeInTheDocument();
    expect(dispose).toHaveBeenCalled();
    unmount();
  });

  it('holds keyboard and pointer order during new activity, then applies ranking on exit', async () => {
    const rows = [entry('first'), entry('second')];
    const onOpen = vi.fn();
    const { rerender } = render(<HomeNeedsYou {...shell({ entries: rows, onOpen })} />);
    await screen.findAllByText(/Ada:/);
    const region = screen.getByRole('region', { name: 'For you' });
    const first = within(region).getAllByRole('button')[0];
    act(() => first.focus());
    rerender(<HomeNeedsYou {...shell({ entries: [rows[1], rows[0]], onOpen })} />);
    expect(within(region).getAllByRole('button')[0]).toBe(first);
    expect(first).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(rows[0], '100');
    fireEvent.pointerEnter(region, { pointerType: 'mouse' });
    act(() => first.blur());
    expect(within(region).getAllByRole('button')[0]).toBe(first);
    fireEvent.pointerLeave(region);
    await waitFor(() => expect(within(region).getAllByRole('button')[1]).toBe(first));
  });

  it('makes all overflow reachable and removes revoked entries even while focused', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => entry(`channel-${index}`));
    const { rerender } = render(<HomeNeedsYou {...shell({ entries: rows })} />);
    expect(screen.queryByText('New in channel-7')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getByText('New in channel-7')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'Open channel-7' }).focus());
    rerender(<HomeNeedsYou {...shell({ entries: rows.slice(0, 7) })} />);
    expect(screen.queryByText('New in channel-7')).not.toBeInTheDocument();
  });

  it('uses the local read cursor and refuses a target that is already read', async () => {
    useReadStateStore.setState({
      byAccount: {
        [JSON.stringify(['a', 'user'])]: {
          chat: { channel_id: 'chat', last_message_id: '101', mention_count: 1 },
        },
      },
    });
    render(<HomeNeedsYou {...shell({ entries: [entry('chat', { mentionCount: 1 })] })} />);
    await screen.findByRole('button', { name: 'Retry preview for chat' });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ params: { kind: 'mention', after: '101' } }),
    );
    expect(screen.queryByText(/The build is ready/)).not.toBeInTheDocument();
  });

  it('rejects an attention response owned by another account even with the same channel id', async () => {
    request.mockResolvedValue(response(message('chat', 'Other account message'), 'chat', 'other'));
    render(<HomeNeedsYou {...shell({ entries: [entry('chat')] })} />);
    await screen.findByRole('button', { name: 'Retry preview for chat' });
    expect(screen.queryByText(/Other account message/)).not.toBeInTheDocument();
  });

  it('keeps an explicit absent mention target instead of presenting the latest message as a mention', async () => {
    request.mockResolvedValue(response(null, 'chat', 'user', 'mention'));
    const onOpen = vi.fn();
    render(<HomeNeedsYou {...shell({ entries: [entry('chat', { mentionCount: 2 })], onOpen })} />);
    expect(await screen.findByText(/No unread mention target is available/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'chat' }), undefined);
  });

  it('discards a mention preview and its jump target when reading history is revoked', async () => {
    const row = entry('chat', { mentionCount: 1 });
    const onOpen = vi.fn();
    render(<HomeNeedsYou {...shell({ entries: [row], onOpen })} />);
    await screen.findByText('Ada mentioned you');
    request.mockRejectedValueOnce({ response: { status: 403 } });
    act(() => window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', {
      detail: row.scope,
    })));
    expect(screen.queryByText('Ada mentioned you')).not.toBeInTheDocument();
    expect(screen.queryByText(/The build is ready/)).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Retry preview for chat' });
    await userEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(onOpen).toHaveBeenCalledWith(row, undefined);
  });
});

describe('friend requests and the quiet column', () => {
  const request1: FriendRequestEntry = {
    key: 'request:9',
    userId: '9',
    username: 'Devon Park',
    createdMs: Date.now() - 3_600_000,
  };

  it('puts a friend request above the conversations with one Accept action', async () => {
    const onAccept = vi.fn();
    render(<HomeNeedsYou {...shell({ entries: [entry('chat')], requests: [request1], onAccept })} />);
    const rows = screen.getByRole('region', { name: 'For you' }).querySelectorAll('li');
    expect(rows[0].textContent).toContain('Devon Park');
    expect(rows[0].textContent).toContain('wants to be friends');
    await userEvent.click(
      screen.getByRole('button', { name: "Accept Devon Park's friend request" }),
    );
    expect(onAccept).toHaveBeenCalledWith('9');
    // The count covers requests and conversations together.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('keeps a direct reply reachable when a friend request occupies a visible row', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => entry(`channel-${index}`, { isThreadReply: true }));
    render(<HomeNeedsYou {...shell({ entries: rows, requests: [request1] })} />);
    expect(screen.queryByRole('button', { name: 'Open channel-5' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(screen.getByRole('button', { name: 'Open channel-5' })).toBeVisible();
  });

  it('never claims nothing needs you while the answer is still unknown', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<HomeNeedsYou {...shell({ status: 'loading' })} />);
    expect(screen.getByText(/Checking for new messages/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing new for you/)).not.toBeInTheDocument();

    rerender(<HomeNeedsYou {...shell({ status: 'error', onRefresh })} />);
    expect(screen.getByText(/could not be checked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalled();

    rerender(<HomeNeedsYou {...shell({ status: 'ready' })} />);
    expect(screen.getByText('Nothing new for you right now.')).toBeInTheDocument();
    // §6.9: never "No data", never "It's quiet here".
    expect(screen.queryByText(/No data|It's quiet/)).not.toBeInTheDocument();
  });
});

describe('Home attention after message mutations', () => {
  it('replaces an edited preview and a deleted target without needing a newer channel tail', async () => {
    const row = entry('chat', { mentionCount: 2 });
    const onOpen = vi.fn();
    render(<HomeNeedsYou {...shell({ entries: [row], onOpen })} />);
    await screen.findByText(/The build is ready/);
    request.mockResolvedValueOnce(
      response(message('chat', 'The revised decision'), 'chat', 'user', 'mention'),
    );
    act(() => useReadStateStore.getState().invalidateAttention(row.scope, row.channelId));
    await screen.findByText(/The revised decision/);
    request.mockResolvedValueOnce(
      response({ ...message('chat', 'Next surviving mention'), id: '102' }, 'chat', 'user', 'mention'),
    );
    act(() => useReadStateStore.getState().invalidateAttention(row.scope, row.channelId));
    await screen.findByText(/Next surviving mention/);
    expect(screen.queryByText(/The revised decision/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(onOpen).toHaveBeenCalledWith(row, '102');
  });

  it('does not invalidate another account or channel with the same bare ID', async () => {
    const row = entry('chat');
    render(<HomeNeedsYou {...shell({ entries: [row] })} />);
    await screen.findByText(/The build is ready/);
    act(() => {
      useReadStateStore.getState().invalidateAttention({ serverId: 'b', userId: 'user' }, 'chat');
      useReadStateStore.getState().invalidateAttention({ serverId: 'a', userId: 'other' }, 'chat');
      useReadStateStore.getState().invalidateAttention(row.scope, 'another');
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it('renders the receiving account mention as @you without relabeling other users', async () => {
  request.mockResolvedValue(
    response(message('chat', '<@99> review <@!99> and <@123>'), 'chat', '99', 'mention'),
  );
  render(
    <HomeNeedsYou
      {...shell({ entries: [entry('chat', { mentionCount: 1, scope: { serverId: 'a', userId: '99' } })] })}
    />,
  );
  expect(await screen.findByText(/chat · @you review @you and @someone/)).toBeInTheDocument();
});
