import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelApi } from '../../../api/channels';
import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore } from '../../../stores/glassStore';
import type { Channel } from '../../../types';
import { ChannelSheet } from './ChannelSheet';
import { closeSheets, openChannelSheet, useSheetPages } from './sheetStore';

/**
 * The channel sheet: one frame, a page per thing the channel menu opens, tabs to
 * move between them, and a thread pushed over the list as a conversation of its
 * own. The pages' contents have their own suites; here they are markers.
 */

vi.mock('../../../hooks/useMobile', () => ({ useMobile: () => false }));

vi.mock('../../../api/channels', () => ({
  channelApi: {
    getPins: vi.fn(),
    getThreads: vi.fn(),
    getArchivedThreads: vi.fn(),
    summarizeChannel: vi.fn(),
    getFollowers: vi.fn(),
    addFollower: vi.fn(),
    removeFollower: vi.fn(),
  },
}));

vi.mock('../../media/MediaGalleryPanel', () => ({
  MediaGalleryPanel: ({ guildId, channelId }: { guildId?: string | null; channelId?: string | null }) => (
    <div data-testid="media-page" data-guild={guildId ?? ''} data-channel={channelId ?? ''} />
  ),
}));
vi.mock('../../guild/GuildEconomyPanel', () => ({
  GuildEconomyPanel: ({ guildId }: { guildId: string }) => <div data-testid="leaderboard-page" data-guild={guildId} />,
}));
vi.mock('../../message/ThreadPanel', () => ({
  ThreadPanel: (props: {
    guildId: string;
    threadChannelId: string;
    threadName: string;
    parentChannelName: string;
    onDeleted?: () => void;
  }) => (
    <div data-testid="thread-panel" data-thread={props.threadChannelId} data-name={props.threadName} data-parent={props.parentChannelName}>
      <button type="button" onClick={props.onDeleted}>Simulate delete</button>
    </div>
  ),
}));
vi.mock('../../../hooks/useRoomNotifications', () => ({
  useRoomNotifications: () => ({ levelOf: () => null, savingRoom: () => false, setLevel: vi.fn() }),
}));
vi.mock('../../../hooks/useMutedGuilds', () => ({
  useMutedGuilds: () => ({ mutedGuildKeys: [], toggleMute: vi.fn(), saving: {} }),
}));

const SCOPE = { serverId: '__local__', userId: 'me' };
const GUILD = 'g1';

const channel = (props: Partial<Channel> & { id: string }): Channel =>
  ({ position: 0, created_at: '2026-10-01T12:00:00.000Z', permission_overwrites: [], ...props }) as unknown as Channel;

const thread = (id: string, name: string, archived: boolean, created: string, count = 3): Channel =>
  channel({
    id,
    name,
    guild_id: GUILD,
    type: 6,
    channel_type: 6,
    parent_id: 'c1',
    message_count: count,
    created_at: created,
    thread_metadata: { archived },
  } as never);

function renderSheet(props: { guildId?: string | null; channelId?: string | null } = {}) {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <ChannelSheet
        open
        onClose={onClose}
        guildId={props.guildId === undefined ? GUILD : props.guildId}
        channelId={props.channelId === undefined ? 'c1' : props.channelId}
      />
    </MemoryRouter>,
  );
  return { onClose };
}

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  useGlassStore.getState().reset();
  useSheetPages.getState().reset();
  useAuthStore.setState({ token: 'token', user: { id: 'me', username: 'Sean' } as never });
  useChannelStore.getState().reset();
  useChannelStore.getState().setChannels(
    GUILD,
    [
      channel({ id: 'c1', guild_id: GUILD, name: 'General', type: 0, channel_type: 0 }),
      channel({ id: 'ann', guild_id: GUILD, name: 'Announcements', type: 5, channel_type: 5 }),
    ],
    SCOPE,
  );
  useChannelStore.getState().setChannels(
    '',
    [channel({ id: 'dm1', type: 1, channel_type: 1, guild_id: null, name: 'Vincent' } as never)],
    SCOPE,
  );
  vi.mocked(channelApi.getPins).mockResolvedValue({ data: [] } as never);
  vi.mocked(channelApi.getThreads).mockResolvedValue({ data: [] } as never);
  vi.mocked(channelApi.getArchivedThreads).mockResolvedValue({ data: [] } as never);
  vi.mocked(channelApi.getFollowers).mockResolvedValue({ data: [] } as never);
  vi.mocked(channelApi.summarizeChannel).mockResolvedValue({
    data: { summary: 'Haz 5 is at 9:30.', provider: 'local', model: 'm1', message_count: 12 },
  } as never);
});

describe('the pages a channel has', () => {
  it('has a page for each thing the channel menu opens, and tabs to move between them', () => {
    renderSheet();
    expect(tabNames()).toEqual(['Catch up', 'Pins', 'Threads', 'Media', 'Leaderboard', 'Notifications']);
  });

  it('offers follows in an announcement channel, and only there', () => {
    renderSheet({ channelId: 'ann' });
    expect(tabNames()).toContain('Follows');
  });

  it('gives a direct message only what it can use', () => {
    renderSheet({ guildId: null, channelId: 'dm1' });
    expect(tabNames()).toEqual(['Catch up', 'Pins', 'Media']);
  });

  it('gives a server page with no channel only the pages about the server', () => {
    renderSheet({ channelId: null });
    expect(tabNames()).toEqual(['Media', 'Leaderboard']);
    expect(screen.getByRole('dialog', { name: 'Media' })).toBeInTheDocument();
    expect(screen.getByText('Every channel you can read')).toBeInTheDocument();
  });

  it('opens on the page it was asked for, named in the title and marked in the tabs', () => {
    openChannelSheet('media');
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Media' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Media' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('media-page')).toHaveAttribute('data-channel', 'c1');
    expect(screen.getByText('General')).toBeInTheDocument();
  });

  it('opens on pins when no page was named (it costs nothing; the summary would ask a model)', () => {
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Pinned messages' })).toBeInTheDocument();
    expect(channelApi.summarizeChannel).not.toHaveBeenCalled();
  });

  it('moves between pages from its tabs without closing', async () => {
    const user = userEvent.setup();
    openChannelSheet('pins');
    renderSheet();
    await user.click(screen.getByRole('tab', { name: 'Leaderboard' }));
    expect(screen.getByRole('dialog', { name: 'Server leaderboard' })).toBeInTheDocument();
    expect(screen.getByTestId('leaderboard-page')).toHaveAttribute('data-guild', GUILD);
    expect(useSheetPages.getState().channelPage).toBe('leaderboard');
    expect(useGlassStore.getState().sheet).toBe('channel');
  });

  it('falls back to a page it has when it is asked for one the channel does not (follows on a text channel)', () => {
    openChannelSheet('follows');
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Pinned messages' })).toBeInTheDocument();
  });

  it('shows the pins it loaded', async () => {
    vi.mocked(channelApi.getPins).mockResolvedValue({
      data: [
        {
          id: 'p1',
          channel_id: 'c1',
          author: { id: 'u2', username: 'brendan', display_name: 'Brendan' },
          content: 'Haz 5 runs from 9.',
          created_at: '2026-10-01T20:41:00.000Z',
        },
      ],
    } as never);
    renderSheet();
    expect(await screen.findByText('Haz 5 runs from 9.')).toBeInTheDocument();
    expect(channelApi.getPins).toHaveBeenCalledWith('c1');
  });
});

/** Standing inside a thread means the thread is a channel the client already knows. */
function seedThreads() {
  useChannelStore.getState().setChannels(
    GUILD,
    [
      channel({ id: 'c1', guild_id: GUILD, name: 'General', type: 0, channel_type: 0 }),
      thread('t-old', 'Patch feedback', false, '2026-09-30T16:00:00.000Z', 9),
      thread('t-new', 'Movie night picks', false, '2026-10-01T19:30:00.000Z', 14),
    ],
    SCOPE,
  );
}

describe('threads, pushed as a conversation', () => {
  beforeEach(() => {
    vi.mocked(channelApi.getThreads).mockResolvedValue({
      data: [
        thread('t-old', 'Patch feedback', false, '2026-09-30T16:00:00.000Z', 9),
        thread('t-new', 'Movie night picks', false, '2026-10-01T19:30:00.000Z', 14),
      ],
    } as never);
    vi.mocked(channelApi.getArchivedThreads).mockResolvedValue({
      data: [thread('t-arch', 'Haz 4 recap', true, '2026-09-24T21:00:00.000Z', 31)],
    } as never);
    openChannelSheet('threads');
  });

  it('lists the newest first and the archived last, with how many messages each holds', async () => {
    renderSheet();
    const list = await screen.findByRole('list', { name: 'Threads' });
    const names = within(list).getAllByRole('button').map((button) => button.textContent);
    expect(names[0]).toMatch(/Movie night picks.*14 messages/);
    expect(names[1]).toMatch(/Patch feedback.*9 messages/);
    expect(names[2]).toMatch(/Haz 4 recap.*Archived.*31 messages/);
  });

  it('takes over the column with the thread when one is picked, and Back returns to the list', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByRole('button', { name: /Movie night picks/ }));

    const pushed = screen.getByRole('dialog', { name: 'Thread: Movie night picks' });
    const panel = within(pushed).getByTestId('thread-panel');
    expect(panel).toHaveAttribute('data-thread', 't-new');
    expect(panel).toHaveAttribute('data-parent', 'General');
    // Its own title and a back button; the page tabs are put away.
    expect(within(pushed).getByRole('heading', { name: 'Movie night picks' })).toBeInTheDocument();
    expect(within(pushed).queryByRole('tab')).not.toBeInTheDocument();

    await user.click(within(pushed).getByRole('button', { name: 'Back to threads' }));
    expect(screen.getByRole('dialog', { name: 'Threads' })).toBeInTheDocument();
    expect(screen.queryByTestId('thread-panel')).not.toBeInTheDocument();
    expect(useSheetPages.getState().threadId).toBeNull();
  });

  it('goes back to the list when the pushed thread is deleted', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();
    await user.click(await screen.findByRole('button', { name: /Movie night picks/ }));
    await user.click(screen.getByRole('button', { name: 'Simulate delete' }));
    expect(screen.getByRole('dialog', { name: 'Threads' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the sheet, rather than drawing a second copy, for the thread you are already reading', async () => {
    const user = userEvent.setup();
    seedThreads();
    const { onClose } = renderSheet({ channelId: 't-new' });
    const list = await screen.findByRole('list', { name: 'Threads' });
    const here = within(list).getByRole('button', { name: /Movie night picks/ });
    expect(here).toHaveAttribute('aria-current', 'true');
    expect(here).toHaveTextContent('You’re here');
    await user.click(here);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('thread-panel')).not.toBeInTheDocument();
  });

  it('lists the siblings of a thread from inside it', async () => {
    seedThreads();
    renderSheet({ channelId: 't-old' });
    expect(await screen.findByRole('button', { name: /Movie night picks/ })).toBeInTheDocument();
    expect(channelApi.getThreads).toHaveBeenCalledWith('c1');
  });

  it('says so when a room has no threads', async () => {
    vi.mocked(channelApi.getThreads).mockResolvedValue({ data: [] } as never);
    vi.mocked(channelApi.getArchivedThreads).mockResolvedValue({ data: [] } as never);
    useChannelStore.getState().reset();
    useChannelStore.getState().setChannels(GUILD, [channel({ id: 'c1', guild_id: GUILD, name: 'General', type: 0, channel_type: 0 })], SCOPE);
    renderSheet();
    expect(await screen.findByText('No threads yet')).toBeInTheDocument();
  });

  it('says why when threads cannot be loaded', async () => {
    vi.mocked(channelApi.getThreads).mockRejectedValue(new Error('Threads are down'));
    useChannelStore.getState().reset();
    useChannelStore.getState().setChannels(GUILD, [channel({ id: 'c1', guild_id: GUILD, name: 'General', type: 0, channel_type: 0 })], SCOPE);
    renderSheet();
    expect(await screen.findByText(/Failed to load threads/)).toBeInTheDocument();
  });
});

describe('the catch-up summary', () => {
  it('reads the channel when its page opens, and says which model answered', async () => {
    openChannelSheet('summary');
    renderSheet();
    expect(screen.getByText('Reading the last few hours…')).toBeInTheDocument();
    expect(await screen.findByText('Haz 5 is at 9:30.')).toBeInTheDocument();
    expect(screen.getByText('Provider local')).toBeInTheDocument();
    expect(screen.getByText('Model m1')).toBeInTheDocument();
    expect(screen.getByText('12 messages')).toBeInTheDocument();
    expect(channelApi.summarizeChannel).toHaveBeenCalledWith('c1', 180);
  });

  it('says why when it cannot', async () => {
    vi.mocked(channelApi.summarizeChannel).mockRejectedValue(new Error('No model is configured'));
    openChannelSheet('summary');
    renderSheet();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to summarize channel');
  });

  it('gives the reason it could not, not only that it could not', async () => {
    vi.mocked(channelApi.summarizeChannel).mockRejectedValue(new Error('AI provider is not configured.'));
    openChannelSheet('summary');
    renderSheet();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to summarize channel: AI provider is not configured.',
    );
  });
});

describe('channel follows', () => {
  beforeEach(() => {
    vi.mocked(channelApi.getFollowers).mockResolvedValue({
      data: [{ id: 'f1', target_channel_id: 'c1', target_guild_id: GUILD }],
    } as never);
    openChannelSheet('follows');
  });

  it('lists the channels an announcement channel can follow into, with what each is doing', async () => {
    renderSheet({ channelId: 'ann' });
    const list = await screen.findByRole('list', { name: 'Channels to follow into' });
    expect(within(list).getByText('General')).toBeInTheDocument();
    expect(within(list).getByText('Posts from here appear in this channel.')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Unfollow' })).toBeInTheDocument();
  });

  it('unfollows, then reads the follows again', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.removeFollower).mockResolvedValue({} as never);
    renderSheet({ channelId: 'ann' });
    await user.click(await screen.findByRole('button', { name: 'Unfollow' }));
    await waitFor(() => expect(channelApi.removeFollower).toHaveBeenCalledWith('ann', 'c1'));
    await waitFor(() => expect(channelApi.getFollowers).toHaveBeenCalledTimes(2));
  });

  it('says why a change failed, in words', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.removeFollower).mockRejectedValue(new Error('Follow is locked'));
    renderSheet({ channelId: 'ann' });
    await user.click(await screen.findByRole('button', { name: 'Unfollow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to unfollow channel');
  });

  it('says why following failed, with the reason the server gave', async () => {
    const user = userEvent.setup();
    vi.mocked(channelApi.getFollowers).mockResolvedValue({ data: [] } as never);
    vi.mocked(channelApi.addFollower).mockRejectedValue(new Error('Manage Webhooks is required.'));
    renderSheet({ channelId: 'ann' });
    await user.click(await screen.findByRole('button', { name: 'Follow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to follow channel: Manage Webhooks is required.');
  });
});

describe('closing', () => {
  it('closes from its button and from Escape, both through onClose', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();
    await user.click(screen.getByRole('button', { name: /^Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    closeSheets();
  });
});
