import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { savedMessagesApi } from '../../../api/savedMessages';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { useAuthStore } from '../../../stores/authStore';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useSavedMessageStore } from '../../../stores/savedMessageStore';
import { InboxPage } from './InboxPage';

/** Inbox (docs/index-spec.md §6.6): the page that replaces the Glass inbox overlay, with the same four views. */

vi.mock('../../../api/channels', () => ({
  createChannelApi: () => channelApi,
  channelApi: { getMessages: vi.fn(), updateReadState: vi.fn() },
}));
vi.mock('../../../api/savedMessages', () => ({
  savedMessagesApi: { list: vi.fn(), save: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));
vi.mock('../../../hooks/useMutedGuilds', () => ({ useMutedGuilds: () => ({ mutedGuildKeys: [] }) }));

const channelApi = vi.hoisted(() => ({ getMessages: vi.fn(), updateReadState: vi.fn() }));
const world = vi.hoisted(() => ({
  entries: [] as unknown[],
  previews: {} as Record<string, unknown>,
}));

vi.mock('../../../hooks/useUnifiedConversations', () => ({
  useUnifiedConversations: () => ({ pinned: [], needsYou: world.entries, recent: [], requests: [], needsYouOverflowCount: 0, spaces: [] }),
}));
vi.mock('../../../hooks/useGuilds', () => ({
  useAvailableGuilds: () => [{ id: 'guild-1', name: 'Launch', icon: null, icon_hash: null, hue: null }],
}));
vi.mock('./useConversationPreview', () => ({
  useConversationPreview: (entry: { channelId: string }) => ({
    preview: world.previews[entry.channelId] ?? null,
    text: 'Loading…',
    failed: false,
    historyUnavailable: false,
    retry: () => {},
  }),
}));
vi.mock('../../glass/places/usePlacesData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../glass/places/usePlacesData')>()),
  useMinuteClock: () => NOW,
}));
vi.mock('../../layout/overlays/RemindersPane', () => ({
  RemindersPane: ({ empty }: { empty: React.ReactNode }) => <div data-testid="reminders-pane">{empty}</div>,
}));
vi.mock('../../../lib/attention/conversationNavigation', () => ({
  activateConversation: (entry: { guildId: string | null; channelId: string }) =>
    entry.guildId ? `/app/guilds/${entry.guildId}/channels/${entry.channelId}` : `/app/dms/${entry.channelId}`,
}));

const SCOPE = { serverId: '__local__', userId: 'viewer' };
const EPOCH_MS = 1704067200000;
const idAt = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();
const NOW = new Date(2026, 9, 1, 21, 38).getTime();

const message = {
  id: 'message-3',
  channel_id: 'channel-2',
  author: { id: 'user-2', username: 'Grace', display_name: 'Grace H.', discriminator: '0002' },
  content: 'Can you review the launch checklist?',
  type: 0,
  attachments: [],
};

const entry = (over: Partial<ConversationEntry>): ConversationEntry => ({
  key: 'k',
  scope: SCOPE,
  serverId: '__local__',
  channelId: 'channel-2',
  guildId: 'guild-1',
  kind: 'guild_text',
  title: 'launch',
  contextLabel: 'Launch',
  lastActivityId: idAt(NOW - 60_000),
  unread: true,
  mentionCount: 0,
  isDMUnread: false,
  isThreadReply: false,
  hasVoiceActivity: false,
  pinned: false,
  ...over,
});

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{`${pathname}${search}`}</output>;
}

function renderInbox() {
  return render(
    <MemoryRouter initialEntries={['/app/inbox']}>
      <Routes>
        <Route path="/app/inbox" element={<><InboxPage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ token: 'token', user: { id: 'viewer' } as never });
  useReadStateStore.getState().reset();
  useSavedMessageStore.getState().reset();
  vi.mocked(savedMessagesApi.list).mockResolvedValue({ data: { items: [], total: 0 } } as never);
  vi.mocked(savedMessagesApi.remove).mockResolvedValue({ data: {} } as never);
  channelApi.updateReadState.mockResolvedValue({ data: {} });
  world.entries = [entry({ mentionCount: 2 })];
  world.previews = { 'channel-2': { author: 'Grace H.', authorId: 'user-2', avatar: null, text: message.content, messageId: 'message-3', message } };
});

describe('InboxPage', () => {
  it('is a page under a large title, opening on mentions when there are any, with the counts in its tabs', () => {
    renderInbox();
    expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByText('2 mentions · 1 conversation with something new')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Mentions/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Mentions 2' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Unread 1' })).toBeInTheDocument();
  });

  it('gives a conversation real message context: where it is, who said what, a white count', () => {
    renderInbox();
    const row = screen.getByTestId('ix-inbox-row');
    expect(row).toHaveTextContent('launch');
    expect(row).toHaveTextContent('in Launch');
    expect(row).toHaveTextContent('Grace H.: Can you review the launch checklist?');
    expect(row.querySelector('.ix-ib__badge')).toHaveTextContent('2');
    expect(within(row).getByRole('button', { name: /^launch/ })).toHaveAccessibleName(/unread, 2 mentions/);
  });

  it('says the time of the last message the way the sidebar does, and does not say a one-to-one name twice', () => {
    world.entries = [entry({ kind: 'dm', guildId: null, contextLabel: null, title: 'Grace H.', lastActivityId: idAt(NOW - 60_000) })];
    renderInbox();
    const row = screen.getByTestId('ix-inbox-row');
    expect(row).toHaveTextContent('9:37 PM');
    expect(row.querySelector('.ix-ib__line')).toHaveTextContent(/^Can you review the launch checklist\?$/);
  });

  it('opens the conversation at the message', () => {
    renderInbox();
    fireEvent.click(within(screen.getByTestId('ix-inbox-row')).getByRole('button', { name: /^launch/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/guild-1/channels/channel-2?message=message-3');
  });

  it('opens on Unread when nothing mentions you, and says so when nothing waits', () => {
    world.entries = [entry({})];
    const { unmount } = renderInbox();
    expect(screen.getByRole('tab', { name: /^Unread/ })).toHaveAttribute('aria-selected', 'true');
    unmount();
    world.entries = [];
    renderInbox();
    expect(screen.getByText('Nothing is waiting for you')).toBeInTheDocument();
    expect(screen.getByText('You’re all caught up')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('a mention tab with none says so; once you pick a tab it stays where you put it', () => {
    world.entries = [entry({})];
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: /^Mentions/ }));
    expect(screen.getByText('No mentions waiting')).toBeInTheDocument();
  });

  it('the check marks one conversation read', async () => {
    renderInbox();
    fireEvent.click(screen.getByRole('button', { name: 'Mark launch as read' }));
    await waitFor(() => expect(channelApi.updateReadState).toHaveBeenCalledWith('channel-2', (world.entries as ConversationEntry[])[0].lastActivityId));
    expect(useReadStateStore.getState().getReadState(SCOPE, 'channel-2')).toMatchObject({ mention_count: 0 });
  });

  it('marks every conversation that is waiting read from one action', async () => {
    world.entries = [entry({ mentionCount: 1 }), entry({ key: 'k2', channelId: 'channel-9', title: 'plans' })];
    renderInbox();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(channelApi.updateReadState).toHaveBeenCalledTimes(2));
    expect(channelApi.updateReadState).toHaveBeenCalledWith('channel-9', expect.any(String));
  });

  it('lists saved messages and removes them without leaving the page', async () => {
    vi.mocked(savedMessagesApi.list).mockResolvedValue({
      data: { items: [{ message, saved_at: '2026-07-11T12:00:00Z', channel: { id: 'channel-2', name: 'launch', guild_id: 'guild-1' } }], total: 1 },
    } as never);
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: /^Saved/ }));
    const saved = await screen.findByText('Can you review the launch checklist?');
    fireEvent.click(saved);
    expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/guild-1/channels/channel-2?message=message-3');
  });

  it('removes a saved message and says the list is empty', async () => {
    vi.mocked(savedMessagesApi.list).mockResolvedValue({
      data: { items: [{ message, saved_at: '2026-07-11T12:00:00Z', channel: { id: 'channel-2', name: 'launch', guild_id: 'guild-1' } }], total: 1 },
    } as never);
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: /^Saved/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Remove message from Grace H\./ }));
    await waitFor(() => expect(savedMessagesApi.remove).toHaveBeenCalledWith('message-3'));
    expect(await screen.findByText('Nothing saved yet')).toBeInTheDocument();
  });

  it('says it could not load saved messages, rather than showing none', async () => {
    vi.mocked(savedMessagesApi.list).mockRejectedValue(new Error('down'));
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: /^Saved/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load saved messages');
  });

  it('reminders are the reminders pane, with its own empty words', () => {
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: /^Reminders/ }));
    expect(screen.getByTestId('reminders-pane')).toHaveTextContent('No reminders');
  });
});
