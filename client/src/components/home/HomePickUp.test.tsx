import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HomePickUp } from './HomePickUp';
import type { ConversationEntry } from '../../lib/attention/conversationModel';
import { clearDatabaseHistoryMemory } from '../../lib/databaseHistory';
import { captureScopedOperation } from '../../lib/operationContext';
import { useReadStateStore } from '../../stores/readStateStore';

vi.mock('../../lib/operationContext', () => ({ captureScopedOperation: vi.fn() }));
vi.mock('../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

const request = vi.fn();
const dispose = vi.fn();

function entry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  const scope = overrides.scope ?? { serverId: 'a', userId: 'viewer' };
  const channelId = overrides.channelId ?? 'chat';
  return {
    scope,
    serverId: scope.serverId,
    key: JSON.stringify([scope.serverId, scope.userId, channelId]),
    channelId,
    guildId: 'community',
    kind: 'guild_text',
    title: 'weekend-plans',
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

function message(content = 'Anyone up for a walk later?', channelId = 'chat') {
  return {
    id: '100',
    channel_id: channelId,
    content,
    author: { id: 'ada', username: 'ada', display_name: 'Ada' },
    attachments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearDatabaseHistoryMemory();
  useReadStateStore.setState({ byAccount: {}, attentionRevisions: {} });
  vi.mocked(captureScopedOperation).mockImplementation(
    (scope) => ({ request: (config: unknown) => request({ ...(config as object), scope }), dispose }) as never,
  );
  request.mockResolvedValue({ data: [message()] });
});

describe('Pick up the conversation', () => {
  it('shows the real last author and message and opens the whole row with the keyboard', async () => {
    const row = entry();
    const onOpen = vi.fn();
    render(<HomePickUp entries={[row]} litRooms={new Set()} onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: 'Open weekend-plans' });
    await screen.findByText('Anyone up for a walk later?');
    expect(button).toHaveAccessibleDescription(/Workshop\s*· unread Ada:\s*Anyone up for a walk later\?/);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      scope: row.scope,
      method: 'GET',
      url: '/channels/chat/messages',
      params: { limit: 1 },
    }));
    act(() => button.focus());
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(row);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('keeps the same channel ID on different accounts and servers separate', async () => {
    const first = entry();
    const second = entry({ scope: { serverId: 'b', userId: 'other' }, title: 'other-chat' });
    request.mockImplementation(({ scope }: { scope: { serverId: string; userId: string } }) =>
      Promise.resolve({ data: [message(`${scope.serverId}/${scope.userId} conversation`)] }),
    );
    render(<HomePickUp entries={[first, second]} litRooms={new Set()} onOpen={vi.fn()} />);
    expect(await screen.findByText('a/viewer conversation')).toBeVisible();
    expect(await screen.findByText('b/other conversation')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open weekend-plans' }))
      .toHaveAccessibleDescription(/a\/viewer conversation/);
    expect(screen.getByRole('button', { name: 'Open other-chat' }))
      .toHaveAccessibleDescription(/b\/other conversation/);
    expect(captureScopedOperation).toHaveBeenCalledWith(first.scope);
    expect(captureScopedOperation).toHaveBeenCalledWith(second.scope);
  });

  it('never exposes encrypted content, ciphertext, polls, or attachment details', async () => {
    request.mockResolvedValue({ data: [{
      ...message('private plaintext'),
      e2ee: { ciphertext: 'private ciphertext' },
      poll: { question: 'private poll' },
      attachments: [{ filename: 'private-photo.png' }],
    }] });
    render(<HomePickUp entries={[entry({ kind: 'dm', title: 'Ada', userId: 'ada' })]} litRooms={new Set()} onOpen={vi.fn()} />);
    expect(await screen.findByText('Encrypted message — open the conversation to read')).toBeVisible();
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Ada' }))
      .toHaveAccessibleDescription(/Direct message\s*· unread Encrypted message — open the conversation to read/);
  });

  it('hides the previous account preview immediately and ignores its late response', async () => {
    const first = entry();
    const second = entry({ scope: { serverId: 'a', userId: 'other' } });
    let resolveOld!: (value: unknown) => void;
    const { rerender } = render(<HomePickUp entries={[first]} litRooms={new Set()} onOpen={vi.fn()} />);
    await screen.findByText('Anyone up for a walk later?');
    request.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    act(() => useReadStateStore.getState().invalidateAttention(first.scope, first.channelId));
    expect(screen.queryByText('Anyone up for a walk later?')).not.toBeInTheDocument();
    request.mockResolvedValue({ data: [message('The other account’s conversation')] });
    rerender(<HomePickUp entries={[second]} litRooms={new Set()} onOpen={vi.fn()} />);
    await screen.findByText('The other account’s conversation');
    await act(async () => resolveOld({ data: [message('Late private message')] }));
    expect(screen.queryByText('Late private message')).not.toBeInTheDocument();
    expect(dispose).toHaveBeenCalled();
  });

  it('rejects messages from the wrong channel and lets the reader retry', async () => {
    request.mockResolvedValueOnce({ data: [message('Unrelated conversation', 'wrong')] });
    render(<HomePickUp entries={[entry()]} litRooms={new Set()} onOpen={vi.fn()} />);
    const retry = await screen.findByRole('button', { name: 'Retry preview for weekend-plans' });
    expect(screen.queryByText('Unrelated conversation')).not.toBeInTheDocument();
    await userEvent.click(retry);
    await screen.findByText('Anyone up for a walk later?');
    expect(screen.queryByRole('button', { name: 'Retry preview for weekend-plans' })).not.toBeInTheDocument();
  });

  it('updates an edited or deleted last message without relying on a newer channel tail', async () => {
    const row = entry();
    render(<HomePickUp entries={[row]} litRooms={new Set()} onOpen={vi.fn()} />);
    await screen.findByText('Anyone up for a walk later?');
    request.mockResolvedValueOnce({ data: [message('A little later, at six?')] });
    act(() => useReadStateStore.getState().invalidateAttention(row.scope, row.channelId));
    await screen.findByText('A little later, at six?');
    request.mockResolvedValueOnce({ data: [] });
    act(() => useReadStateStore.getState().invalidateAttention(row.scope, row.channelId));
    await screen.findByText('No message preview available');
    expect(screen.queryByText('A little later, at six?')).not.toBeInTheDocument();
  });

  it('drops a cached preview while a permission change is rechecked and keeps it hidden on denial', async () => {
    const row = entry();
    let rejectCheck!: (reason: unknown) => void;
    render(<HomePickUp entries={[row]} litRooms={new Set()} onOpen={vi.fn()} />);
    await screen.findByText('Anyone up for a walk later?');
    request.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectCheck = reject; }));
    act(() => window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', {
      detail: row.scope,
    })));
    expect(screen.queryByText('Anyone up for a walk later?')).not.toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeVisible();
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => rejectCheck({ response: { status: 403 } }));
    expect(screen.getByText('Preview unavailable')).toBeVisible();
    expect(screen.queryByText('Anyone up for a walk later?')).not.toBeInTheDocument();
  });

  it('only rechecks capabilities for its own account and the affected channel', async () => {
    const row = entry();
    render(<HomePickUp entries={[row]} litRooms={new Set()} onOpen={vi.fn()} />);
    await screen.findByText('Anyone up for a walk later?');
    act(() => {
      for (const detail of [
        { serverId: 'b', userId: row.scope.userId },
        { serverId: row.scope.serverId, userId: 'other' },
        { ...row.scope, channelId: 'another-channel' },
      ]) {
        window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', { detail }));
      }
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Anyone up for a walk later?')).toBeVisible();
    act(() => window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', {
      detail: { ...row.scope, channelId: row.channelId },
    })));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('refuses an old request that resolves immediately after a permission invalidation', async () => {
    const row = entry();
    let resolveOld!: (value: unknown) => void;
    let rejectCheck!: (reason: unknown) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    request.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectCheck = reject; }));
    render(<HomePickUp entries={[row]} litRooms={new Set()} onOpen={vi.fn()} />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', { detail: row.scope }));
      resolveOld({ data: [message('Content from the revoked permission')] });
    });
    expect(dispose).toHaveBeenCalled();
    expect(screen.queryByText('Content from the revoked permission')).not.toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeVisible();
    await act(async () => rejectCheck({ response: { status: 403 } }));
    expect(screen.getByText('Preview unavailable')).toBeVisible();
    expect(screen.queryByText('Content from the revoked permission')).not.toBeInTheDocument();
  });

  it('does not request a message for an empty channel or invent an author', async () => {
    render(<HomePickUp entries={[entry({ lastActivityId: null })]} litRooms={new Set()} onOpen={vi.fn()} />);
    expect(screen.getByText('No message preview available')).toBeVisible();
    await waitFor(() => expect(captureScopedOperation).not.toHaveBeenCalled());
    expect(screen.queryByText('Ada:')).not.toBeInTheDocument();
  });

  it('only relabels mentions of the account receiving the preview', async () => {
    request.mockResolvedValue({ data: [message('<@99> bring <@!99> and <@123>')] });
    render(<HomePickUp entries={[entry({ scope: { serverId: 'a', userId: '99' } })]} litRooms={new Set()} onOpen={vi.fn()} />);
    expect(await screen.findByText('@you bring @you and @someone')).toBeVisible();
  });
});
