import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeNeedsYou, homeAttention } from './HomeNeedsYou';
import { useReadStateStore } from '../../stores/readStateStore';
import { captureScopedOperation } from '../../lib/operationContext';
import type { ConversationEntry } from '../../lib/attention/conversationModel';
import { acceptDatabaseHistoryEpoch, clearDatabaseHistoryMemory, registerHistoryReconciler } from '../../lib/databaseHistory';

vi.mock('../../lib/operationContext', () => ({ captureScopedOperation: vi.fn() }));
vi.mock('../../stores/serverListStore', () => ({ useServerListStore: (select: (state: unknown) => unknown) => select({ servers: [{ id: 'a', name: 'North' }, { id: 'b', name: 'South' }] }) }));
const request = vi.fn();
const dispose = vi.fn();
function entry(id: string, overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  const scope = overrides.scope ?? { serverId: 'a', userId: 'user' };
  return { scope, serverId: scope.serverId, key: JSON.stringify([scope.serverId, scope.userId, id]), channelId: id, guildId: 'space', kind: 'guild_text', title: id, contextLabel: 'Workshop', lastActivityId: '100', unread: true, mentionCount: 0, isDMUnread: false, isThreadReply: false, hasVoiceActivity: false, pinned: false, ...overrides };
}
function response(message: unknown, channel = 'chat', user = 'user', kind = 'unread') { return { data: { channel_id: channel, user_id: user, kind, message } }; }
function message(channel = 'chat', content = 'The build is ready') { return { id: '100', channel_id: channel, content, author: { username: 'Ada' }, attachments: [] }; }
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearDatabaseHistoryMemory();
  useReadStateStore.setState({ byAccount: {}, attentionRevisions: {} });
  vi.mocked(captureScopedOperation).mockImplementation(scope => ({ request: (config: unknown) => request({ ...(config as object), scope }), dispose }) as never);
  request.mockImplementation(({ url, params, scope }: { url: string; params: { kind: string }; scope: { userId: string } }) => Promise.resolve(response(message(url.split('/')[2]), url.split('/')[2], scope.userId, params.kind)));
});

describe('Home attention', () => {
  it('keeps Home available when history metadata is corrupt and waits for a valid reconnect', async () => {
    localStorage.setItem('paracord:database-history:["a","user"]', 'corrupt');
    const reconcile = vi.fn();
    const unsubscribe = registerHistoryReconciler(reconcile);
    try {
      render(<HomeNeedsYou entries={[entry('chat')]} onOpen={vi.fn()} />);
      expect(screen.getByText(/Reconnect this account to restore previews/)).toBeVisible();
      expect(captureScopedOperation).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Reconnect to load preview for chat' }));
      expect(reconcile).toHaveBeenCalledWith(entry('chat').scope);
      expect(request).not.toHaveBeenCalled();
      act(() => { acceptDatabaseHistoryEpoch(entry('chat').scope, '7257b8f7-610e-4a8b-a20c-5a94a7b98428'); });
      expect(await screen.findByText(/Ada: The build is ready/)).toBeVisible();
    } finally { unsubscribe(); }
  });

  it('includes pinned and overflow attention, deduplicates, and ranks by reason', () => {
    const pinned = entry('pinned', { pinned: true, mentionCount: 1 });
    const dm = entry('dm', { unread: false, isDMUnread: true });
    const thread = entry('thread', { unread: false, isThreadReply: true });
    const voice = entry('voice', { unread: false, hasVoiceActivity: true });
    const read = entry('read', { unread: false });
    expect(homeAttention([voice, read, thread, dm, pinned, pinned, entry('plain')]).map(row => row.title)).toEqual(['pinned', 'dm', 'thread', 'plain', 'voice']);
  });

  it('shows the reason, exact server and space, and opens the owned conversation', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const first = entry('chat', { mentionCount: 2 });
    const second = entry('chat', { scope: { serverId: 'b', userId: 'other' }, title: 'second', isThreadReply: true });
    render(<HomeNeedsYou entries={[first, second]} onOpen={open} />);
    expect(await screen.findAllByText(/Ada: The build is ready/)).toHaveLength(2);
    expect(screen.getByText('2 mentions')).toBeInTheDocument();
    expect(screen.getByText('North')).toBeInTheDocument();
    expect(screen.getByText('South')).toBeInTheDocument();
    expect(captureScopedOperation).toHaveBeenCalledWith(second.scope);
    await user.click(screen.getByRole('button', { name: /Read replies/ }));
    expect(open).toHaveBeenCalledWith(second, '100');
  });

  it('does not show encrypted content or attachment metadata', async () => {
    request.mockResolvedValue(response({ ...message('chat', 'secret plaintext'), e2ee: { ciphertext: 'cipher' }, attachments: [{ filename: 'secret.png' }] }));
    render(<HomeNeedsYou entries={[entry('chat')]} onOpen={vi.fn()} />);
    expect(await screen.findByText(/Encrypted message — open/)).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it('rejects a preview from a different channel and provides retry', async () => {
    request.mockResolvedValueOnce(response(message('wrong', 'Wrong account text')));
    render(<HomeNeedsYou entries={[entry('chat')]} onOpen={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry preview for chat' }));
    expect(await screen.findByText(/Ada: The build is ready/)).toBeInTheDocument();
    expect(screen.queryByText(/Wrong account text/)).not.toBeInTheDocument();
  });

  it('disposes old requests and ignores a late response after the activity changes', async () => {
    let resolve!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { rerender, unmount } = render(<HomeNeedsYou entries={[entry('chat')]} onOpen={vi.fn()} />);
    rerender(<HomeNeedsYou entries={[entry('chat', { lastActivityId: '101' })]} onOpen={vi.fn()} />);
    expect(await screen.findByText(/Ada: The build is ready/)).toBeInTheDocument();
    await act(async () => resolve(response(message('chat', 'stale reply'))));
    expect(screen.queryByText(/stale reply/)).not.toBeInTheDocument();
    expect(dispose).toHaveBeenCalled();
    unmount();
  });

  it('holds keyboard and pointer order during new activity, then applies ranking on exit', async () => {
    const rows = [entry('first'), entry('second')];
    const open = vi.fn();
    const { rerender } = render(<HomeNeedsYou entries={rows} onOpen={open} />);
    await screen.findAllByText(/Ada:/);
    const region = screen.getByRole('region', { name: 'Needs you' });
    const first = within(region).getAllByRole('button')[0];
    act(() => first.focus());
    rerender(<HomeNeedsYou entries={[rows[1], rows[0]]} onOpen={open} />);
    expect(within(region).getAllByRole('button')[0]).toBe(first);
    expect(first).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(open).toHaveBeenCalledWith(rows[0], '100');
    fireEvent.pointerEnter(region, { pointerType: 'mouse' });
    act(() => first.blur());
    expect(within(region).getAllByRole('button')[0]).toBe(first);
    fireEvent.pointerLeave(region);
    await waitFor(() => expect(within(region).getAllByRole('button')[1]).toBe(first));
  });

  it('makes all overflow reachable and removes revoked entries even while focused', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => entry(`channel-${index}`));
    const { rerender } = render(<HomeNeedsYou entries={rows} onOpen={vi.fn()} />);
    expect(screen.queryByText('channel-7')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more conversations' }));
    expect(screen.getByText('channel-7')).toBeInTheDocument();
    act(() => screen.getByText('channel-7').closest('button')!.focus());
    rerender(<HomeNeedsYou entries={rows.slice(0, 7)} onOpen={vi.fn()} />);
    expect(screen.queryByText('channel-7')).not.toBeInTheDocument();
  });
  it('uses the local read cursor and refuses a target that is already read', async () => {
    useReadStateStore.setState({ byAccount: { [JSON.stringify(['a', 'user'])]: { chat: { channel_id: 'chat', last_message_id: '101', mention_count: 1 } } } });
    render(<HomeNeedsYou entries={[entry('chat', { mentionCount: 1 })]} onOpen={vi.fn()} />);
    await screen.findByRole('button', { name: 'Retry preview for chat' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ params: { kind: 'mention', after: '101' } }));
    expect(screen.queryByText(/Ada: The build is ready/)).not.toBeInTheDocument();
  });

  it('rejects an attention response owned by another account even with the same channel id', async () => {
    request.mockResolvedValue(response(message('chat', 'Other account message'), 'chat', 'other'));
    render(<HomeNeedsYou entries={[entry('chat')]} onOpen={vi.fn()} />);
    await screen.findByRole('button', { name: 'Retry preview for chat' });
    expect(screen.queryByText(/Other account message/)).not.toBeInTheDocument();
  });

  it('keeps an explicit absent mention target instead of presenting the latest message as a mention', async () => {
    request.mockResolvedValue(response(null, 'chat', 'user', 'mention'));
    const open = vi.fn();
    render(<HomeNeedsYou entries={[entry('chat', { mentionCount: 2 })]} onOpen={open} />);
    expect(await screen.findByText(/No unread mention target is available/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Open conversation/ }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'chat' }), undefined);
  });
});


describe('Home attention after message mutations', () => {
  it('replaces an edited preview and a deleted target without needing a newer channel tail', async () => {
    const row = entry('chat', { mentionCount: 2 });
    const open = vi.fn();
    render(<HomeNeedsYou entries={[row]} onOpen={open} />);
    await screen.findByText(/The build is ready/);
    request.mockResolvedValueOnce(response(message('chat', 'The revised decision'), 'chat', 'user', 'mention'));
    act(() => useReadStateStore.getState().invalidateAttention(row.scope, row.channelId));
    await screen.findByText(/The revised decision/);
    request.mockResolvedValueOnce(response({ ...message('chat', 'Next surviving mention'), id: '102' }, 'chat', 'user', 'mention'));
    act(() => useReadStateStore.getState().invalidateAttention(row.scope, row.channelId));
    await screen.findByText(/Next surviving mention/);
    expect(screen.queryByText(/The revised decision/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Review mentions/ }));
    expect(open).toHaveBeenCalledWith(row, '102');
  });

  it('does not invalidate another account or channel with the same bare ID', async () => {
    const row = entry('chat');
    render(<HomeNeedsYou entries={[row]} onOpen={vi.fn()} />);
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
  request.mockResolvedValue(response(message('chat', '<@99> review <@!99> and <@123>'), 'chat', '99', 'mention'));
  render(<HomeNeedsYou entries={[entry('chat', { mentionCount: 1, scope: { serverId: 'a', userId: '99' } })]} onOpen={vi.fn()} />);
  expect(await screen.findByText(/Ada: @you review @you and <@123>/)).toBeInTheDocument();
});
