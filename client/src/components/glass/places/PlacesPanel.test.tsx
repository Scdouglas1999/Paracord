import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { createStore } from 'zustand/vanilla';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import type { UnifiedConversations } from '../../../hooks/useUnifiedConversations';
import { useBuildingLights } from '../../../hooks/useLights';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { useUnifiedConversations } from '../../../hooks/useUnifiedConversations';
import { useUnreadCounts } from '../../../hooks/useUnreadCounts';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { buildingLight, personLight, textRoomLight, voiceRoomLight } from '../../../lib/attention/light';
import { entityScopeKey, accountScopeKey } from '../../../lib/serverScope';
import { ChannelType } from '../../../types';
import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { useMenuHostStore } from '../../ix/menus/hostStore';
import { PlacesPanel } from './PlacesPanel';
import { resetUnreadCounts } from './useUnreadMessageCounts';

/**
 * The panel end to end, with the stores real and the slow or remote things
 * (lights, previews, events, add-ons, the unread request) stubbed: which rows a
 * server produces, what each says, where a click goes, how the keyboard moves.
 * The rules behind the rows are in model.test.ts and rows.test.ts.
 */

const SCOPE = { serverId: 'srv', userId: 'me' };
const GUILD_KEY = entityScopeKey(SCOPE, 'g1');
const NOW = new Date(2026, 9, 1, 21, 12).getTime();
const EPOCH_MS = 1704067200000;
const idAt = (ms: number, seq = 0) => ((BigInt(ms - EPOCH_MS) << 22n) + BigInt(seq)).toString();
const CLIPS_CURSOR = idAt(NOW - 3 * 3600_000);
const CLIPS_TAIL = idAt(NOW - 6 * 60_000);
const OLD = idAt(NOW - 9 * 24 * 3600_000);

const previews = vi.hoisted(() => ({ value: null as unknown }));
const events = vi.hoisted(() => ({ value: [] as unknown[] }));
const unreadRequest = vi.hoisted(() => vi.fn());
const messageStore = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../hooks/useLights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useLights')>()),
  useBuildingLights: vi.fn(),
}));
vi.mock('../../../hooks/useBuildingRosters', () => ({ useBuildingRosters: () => {} }));
vi.mock('../../../hooks/useUnifiedConversations', () => ({ useUnifiedConversations: vi.fn() }));
vi.mock('../../../hooks/useGuilds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useGuilds')>()),
  useAvailableGuilds: vi.fn(),
}));
vi.mock('../../../hooks/useUnreadCounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useUnreadCounts')>()),
  useUnreadCounts: vi.fn(),
}));
vi.mock('../../../hooks/useMutedGuilds', () => ({
  useMutedGuilds: () => ({ mutedGuildKeys: [], isMuted: () => false, toggleMute: vi.fn(), saving: {} }),
}));
vi.mock('../../../hooks/useChannelPreviews', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useChannelPreviews')>()),
  useChannelPreviews: () => previews.value,
}));
vi.mock('../../../hooks/useMessageStore', () => ({ useCurrentMessageStoreApi: () => messageStore.current }));
vi.mock('../../../hooks/useRoomMenu', () => ({ useRoomMenu: () => () => [] }));
vi.mock('../../rooms/lobby/useUpcomingEvents', () => ({
  useUpcomingEvents: () => ({ events: events.value, error: null, loaded: true, toggleRsvp: vi.fn() }),
}));
vi.mock('../../../hooks/useSportsBoard', () => ({
  useSportsSettings: () => ({ settings: null, status: 'idle', error: null, board: null, boardError: null, flashes: {} }),
  useSportsPolling: () => {},
}));
vi.mock('../../../hooks/useDailyWord', () => ({ useDailyWordSettings: () => ({ enabled: false }) }));
vi.mock('../../../hooks/useGameServers', () => ({ useGameServers: () => ({ servers: [] }) }));
vi.mock('../../home/useHomeMessagePreview', () => ({
  useHomeMessagePreview: () => ({
    preview: { author: 'Brendan', authorId: 'brendan', avatar: null, text: 'you around for the run?' },
    text: 'you around for the run?',
    failed: false,
    historyUnavailable: false,
    retry: () => {},
  }),
}));
vi.mock('../../../lib/guildNavigation', () => ({
  activateGuild: vi.fn(),
  guildLandingPath: vi.fn(async (guild: { id: string }) => `/app/guilds/${guild.id}/channels/landing`),
}));
vi.mock('../../../lib/attention/conversationNavigation', () => ({
  activateConversation: (entry: { channelId: string }) => `/app/dms/${entry.channelId}`,
}));
vi.mock('../../../lib/operationContext', () => ({
  captureScopedOperation: () => ({ request: unreadRequest, assertCurrent: () => {}, dispose: () => {} }),
}));
vi.mock('../../guild/CreateGuildModal', () => ({
  CreateGuildModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="create-guild-modal">
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));
vi.mock('../../guild/InviteModal', () => ({ InviteModal: () => null }));

const person = (id: string, name: string) => personLight({ userId: id, name, status: 'online', avatar: null });
const VINCENT = person('vincent', 'Vincent');
const BRENDAN = person('brendan', 'Brendan');

const LOUNGE = voiceRoomLight({
  scope: SCOPE,
  guildId: 'g1',
  channelId: 'lounge',
  name: 'Lounge',
  occupants: [
    { person: VINCENT, sharingScreen: true },
    { person: BRENDAN, speaking: true },
  ],
  nowMs: NOW,
});

const KESTREL = buildingLight({
  scope: SCOPE,
  guildId: 'g1',
  name: 'Game Night',
  rooms: [LOUNGE, textRoomLight({ scope: SCOPE, guildId: 'g1', channelId: 'general', name: 'General', candidates: [], nowMs: NOW })],
  members: [VINCENT, BRENDAN, person('nick', 'Nick')],
  memberCount: 8,
});

function channel(id: string, name: string, position: number, over: Record<string, unknown> = {}) {
  return {
    id,
    key: entityScopeKey(SCOPE, id),
    scope: SCOPE,
    guild_id: 'g1',
    name,
    type: ChannelType.Text,
    channel_type: ChannelType.Text,
    position,
    nsfw: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const GENERAL_TAIL = idAt(NOW - 3 * 60_000);

function seedStores() {
  useAuthStore.setState({ user: { id: 'me', username: 'me', flags: 0 } as never, token: 't' });
  useServerListStore.setState({
    activeServerId: 'srv',
    servers: [
      {
        id: 'srv',
        url: 'https://srv.example',
        name: 'Test',
        token: 't',
        userId: 'me',
        user: { id: 'me', username: 'me', flags: 0 } as never,
        connected: true,
      },
    ],
  });
  useChannelStore.setState({
    channelsByGuild: {
      [GUILD_KEY]: [
        channel('general', 'General', 0, { last_message_id: GENERAL_TAIL }),
        channel('lounge', 'Lounge', 1, { type: ChannelType.Voice, channel_type: ChannelType.Voice }),
        channel('clips', 'Clips', 2, { last_message_id: CLIPS_TAIL }),
        channel('patch', 'Patch notes', 3, { last_message_id: OLD }),
      ] as never,
    },
    channelsById: {},
  });
  useReadStateStore.setState({
    byAccount: {
      [accountScopeKey(SCOPE)]: {
        general: { channel_id: 'general', last_message_id: idAt(NOW - 3600_000), mention_count: 1 },
        clips: { channel_id: 'clips', last_message_id: CLIPS_CURSOR, mention_count: 0 },
        patch: { channel_id: 'patch', last_message_id: OLD, mention_count: 0 },
      },
    },
  });
  useMemberStore.setState({ members: new Map(), membersLoaded: {} });
  useGuildStore.setState({ guilds: CIRCLES as never });
}

function entry(over: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    key: entityScopeKey(SCOPE, 'dm-1'),
    scope: SCOPE,
    serverId: 'srv',
    channelId: 'dm-1',
    guildId: null,
    userId: 'brendan',
    avatar: null,
    kind: 'dm',
    title: 'Brendan',
    contextLabel: null,
    lastActivityId: idAt(NOW - 17 * 60_000),
    unread: false,
    mentionCount: 0,
    isDMUnread: true,
    isThreadReply: false,
    hasVoiceActivity: false,
    pinned: false,
    ...over,
  };
}

function conversations(over: Partial<UnifiedConversations> = {}): UnifiedConversations {
  return { needsYou: [], needsYouOverflowCount: 0, pinned: [], recent: [], spaces: [], requests: [], ...over };
}

function previewEntry(over: Partial<ChannelPreviewEntry> & Pick<ChannelPreviewEntry, 'channelId'>): ChannelPreviewEntry {
  return {
    messageId: '1',
    messageType: 0,
    author: { id: 'jeremy', kind: 'user', name: 'Jeremy', avatar: null },
    content: 'hello',
    encrypted: false,
    createdAt: new Date(NOW - 60_000).toISOString(),
    media: null,
    attachmentCount: 0,
    hasSticker: false,
    ...over,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

function renderPanel(path = '/app/guilds/g1/channels/general', props: Partial<Parameters<typeof PlacesPanel>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<PlacesPanel presentation="pane" {...props} />} />
        <Route path="/app/guilds/:guildId" element={<PlacesPanel presentation="pane" {...props} />} />
        <Route path="/app/dms/:channelId" element={<PlacesPanel presentation="pane" {...props} />} />
        <Route path="*" element={<PlacesPanel presentation="pane" {...props} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

const CIRCLES = [
  { key: GUILD_KEY, scope: SCOPE, id: 'g1', name: 'Game Night', icon_hash: null, owner_id: 'me' },
  { key: entityScopeKey(SCOPE, 'g2'), scope: SCOPE, id: 'g2', name: 'Basecamp', icon_hash: null, owner_id: 'other' },
];

beforeEach(() => {
  // Only the date is pinned: the panel's own timers and the test's waits stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetUnreadCounts();
  unreadRequest.mockReset();
  unreadRequest.mockResolvedValue({ data: [{ id: '1', author: { id: 'them' } }, { id: '2', author: { id: 'them' } }, { id: '3', author: { id: 'them' } }] });
  seedStores();
  useGlassStore.getState().reset();
  useMenuHostStore.getState().reset();
  messageStore.current = createStore(() => ({ messages: {}, deletedMessageIds: new Set<string>() }));
  previews.value = {
    status: 'ready',
    error: null,
    previews: new Map([
      ['general', previewEntry({ channelId: 'general', content: '<@42> is movie night still on?', createdAt: new Date(NOW - 3 * 60_000).toISOString() })],
      ['clips', previewEntry({ channelId: 'clips', author: { id: 'nick', kind: 'user', name: 'Nick', avatar: null }, content: 'new personal best, 41:07', createdAt: new Date(NOW - 6 * 60_000).toISOString() })],
      ['patch', previewEntry({ channelId: 'patch', content: '1.4.2 is live', createdAt: new Date(NOW - 9 * 24 * 3600_000).toISOString() })],
    ]),
    recentAuthors: new Map([['general', [{ id: 'jeremy', kind: 'user', name: 'Jeremy', avatar: null }]]]),
  };
  events.value = [];
  vi.mocked(useBuildingLights).mockReturnValue([KESTREL]);
  vi.mocked(useAvailableGuilds).mockReturnValue(CIRCLES as never);
  vi.mocked(useUnreadCounts).mockReturnValue({ guildUnreads: new Map(), isChannelUnread: new Set(), channelMentionCounts: new Map(), readStates: [] } as never);
  vi.mocked(useUnifiedConversations).mockReturnValue(conversations());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PlacesPanel: a server', () => {
  it('shows the server row, the title with its line, and the channels as rows', async () => {
    renderPanel();
    expect(screen.getByRole('navigation', { name: 'Servers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Game Night menu/ })).toHaveTextContent('Game Night');
    expect(screen.getByRole('button', { name: /^Game Night menu/ })).toHaveTextContent('3 online, 2 in Lounge');

    const channels = screen.getByRole('navigation', { name: 'Channels' });
    const links = within(channels).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('data-row-id'))).toEqual(['channel:general', 'channel:lounge', 'channel:clips', 'channel:patch']);
    // The mention is written as the person's name in the line.
    expect(within(channels).getByRole('link', { name: /General/ })).toHaveTextContent('Jeremy: @someone is movie night still on?');
  });

  it('is a text row, a live row, a text row with a count and a quiet row, in the server’s order', async () => {
    const { container } = renderPanel();
    expect(container.querySelectorAll('.glass-place-live')).toHaveLength(1);
    expect(container.querySelectorAll('.glass-place-row--quiet')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Patch notes/ })).toHaveClass('glass-place-row--quiet');
    expect(screen.getByRole('link', { name: /Lounge/ })).toHaveTextContent('Vincent is streaming');
    // Nobody has written a # anywhere in the panel.
    expect(container.textContent).not.toContain('#');
  });

  it('marks the open channel, and gives it a white @ for its mention', () => {
    renderPanel();
    const general = screen.getByRole('link', { name: /General/ });
    expect(general).toHaveAttribute('aria-current', 'page');
    expect(within(general).getByText('@')).toHaveAttribute('data-tone', 'mention');
    expect(screen.getByRole('link', { name: /Clips/ })).not.toHaveAttribute('aria-current');
  });

  it('shows a dot for an unread channel until the exact count arrives', async () => {
    const { container } = renderPanel();
    const clips = screen.getByRole('link', { name: /Clips/ });
    expect(container.querySelector('.glass-place-dot')).not.toBeNull();
    await waitFor(() => expect(within(clips).getByText('3')).toHaveAttribute('data-tone', 'count'));
    expect(unreadRequest).toHaveBeenCalledTimes(1);
    expect(unreadRequest.mock.calls[0][0]).toMatchObject({ url: '/channels/clips/messages', params: { after: CLIPS_CURSOR } });
  });

  it('does not ask for the count of a channel that mentions you, or of a read one', async () => {
    renderPanel();
    await waitFor(() => expect(unreadRequest).toHaveBeenCalled());
    const asked = unreadRequest.mock.calls.map((call) => call[0].url);
    expect(asked).toEqual(['/channels/clips/messages']);
  });

  it('does not ask for the count of the channel you are reading', async () => {
    renderPanel('/app/guilds/g1/channels/clips');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unreadRequest).not.toHaveBeenCalled();
    // Still unread until the read position moves: a dot, not a guess.
    expect(within(screen.getByRole('link', { name: /Clips/ })).getByText('unread')).toBeInTheDocument();
  });

  it('says the channels are loading, could not be loaded, or are none', () => {
    const empty = () => useChannelStore.setState({ channelsByGuild: {}, guildChannelsLoaded: {}, errors: {} });
    empty();
    const loading = renderPanel();
    expect(screen.getByRole('status')).toHaveTextContent('Loading channels…');
    loading.unmount();

    empty();
    useChannelStore.setState({ errors: { [GUILD_KEY]: 'nope' } });
    const failed = renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent("Could not load this server's channels. nope");
    failed.unmount();

    empty();
    useChannelStore.setState({ guildChannelsLoaded: { [GUILD_KEY]: true } });
    renderPanel();
    expect(screen.getByRole('status')).toHaveTextContent('No channels yet.');
  });

  it('opens a channel on click, activating the server first', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('link', { name: /Clips/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/clips');
  });

  it('opens the live channel’s chat with the stage on its stream beside it, and closes the panel it is in', () => {
    const onClose = vi.fn();
    renderPanel('/app/guilds/g1/channels/general', { presentation: 'browse', onClose });
    fireEvent.click(screen.getByRole('link', { name: /Lounge/ }));
    expect(useGlassStore.getState().stage).toMatchObject({ mode: 'side', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The voice channel's chat beside the stage (owner decision, glass-plan §8.4).
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/lounge');
  });

  it('opens the voice channel itself when nobody is streaming', () => {
    vi.mocked(useBuildingLights).mockReturnValue([
      buildingLight({
        scope: SCOPE,
        guildId: 'g1',
        name: 'Game Night',
        rooms: [voiceRoomLight({ scope: SCOPE, guildId: 'g1', channelId: 'lounge', name: 'Lounge', occupants: [{ person: BRENDAN, speaking: true }], nowMs: NOW })],
        members: [BRENDAN],
        memberCount: 2,
      }),
    ]);
    renderPanel();
    fireEvent.click(screen.getByRole('link', { name: /Lounge/ }));
    expect(useGlassStore.getState().stage.mode).toBe('none');
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/lounge');
  });

  it('shows what is coming up, and opens the event’s channel', () => {
    events.value = [
      {
        id: 'e1',
        name: 'Haz 5 run',
        startsAt: new Date(2026, 9, 1, 21, 30),
        endsAt: null,
        channelId: 'lounge',
        location: null,
        creatorId: 'brendan',
        going: 3,
        youAreGoing: false,
        happeningNow: false,
      },
    ];
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument();
    const row = screen.getByRole('link', { name: /Haz 5 run/ });
    expect(row).toHaveTextContent('Today');
    expect(row).toHaveTextContent('9:30');
    expect(row).toHaveTextContent('Lounge, 3 going');
    fireEvent.click(row);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/lounge');
  });

  describe('a shared event in a preview', () => {
    const sharedIn = (content: string) => {
      const ready = previews.value as { previews: Map<string, ChannelPreviewEntry> };
      ready.previews.set('general', previewEntry({ channelId: 'general', content, createdAt: new Date(NOW - 3 * 60_000).toISOString() }));
    };
    const calendar = (id: string, name: string) => ({
      id,
      name,
      startsAt: new Date(2026, 9, 2, 21, 0),
      endsAt: null,
      channelId: null,
      location: null,
      creatorId: 'brendan',
      going: 0,
      youAreGoing: false,
      happeningNow: false,
    });

    it('reads as the event’s name when the calendar has it', () => {
      sharedIn('<@42> is <event:7002> still on?');
      events.value = [calendar('7002', 'Movie night')];
      renderPanel();
      const channels = screen.getByRole('navigation', { name: 'Channels' });
      expect(within(channels).getByRole('link', { name: /General/ })).toHaveTextContent('Jeremy: @someone is Movie night still on?');
    });

    it('reads as "an event" when the client does not know it, never as the id', () => {
      sharedIn('<@42> is <event:7002> still on?');
      events.value = [calendar('7001', 'Haz 5 run')];
      renderPanel();
      const channels = screen.getByRole('navigation', { name: 'Channels' });
      const line = within(channels).getByRole('link', { name: /General/ });
      expect(line).toHaveTextContent('Jeremy: @someone is an event still on?');
      expect(line).not.toHaveTextContent('7002');
    });
  });

  it('has no Coming up when there is nothing coming up', () => {
    renderPanel();
    expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull();
  });

  it('opens another server on its landing channel', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Basecamp' }));
    await waitFor(() => expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g2/channels/landing'));
  });

  it('leaves you where you are when you click the server you are already in', () => {
    renderPanel();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Servers' })).getByRole('button', { name: /^Game Night/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/general');
  });

  it('takes you to a channel of the current server from its home page', async () => {
    renderPanel('/app/guilds/g1');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Servers' })).getByRole('button', { name: /^Game Night/ }));
    await waitFor(() => expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/landing'));
  });

  it('opens Home from the tray', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Home and direct messages/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app');
    expect(screen.getByTestId('pathname').textContent).not.toContain('guilds');
  });

  it('opens the add flow from the plus', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add or join a server' }));
    expect(screen.getByTestId('create-guild-modal')).toBeInTheDocument();
  });

  it('opens the server menu from the title', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Game Night menu/ }));
    // The menu itself is the Index server menu, rendered once by the sheet slot's
    // menu host (components/ix/menus); the panel only asks for it, at the title.
    const open = useMenuHostStore.getState().menu;
    expect(open?.kind).toBe('server');
    if (open?.kind === 'server') {
      expect(open.server).toMatchObject({ name: 'Game Night' });
      expect('element' in open.anchor).toBe(true);
    }
  });

  it('says so when the server is not one of yours, and keeps the row as a way out', () => {
    vi.mocked(useAvailableGuilds).mockReturnValue([CIRCLES[1]] as never);
    renderPanel();
    expect(screen.getByText('This server is not available.')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Servers' })).toBeInTheDocument();
  });

  it('says why a channel has no line when the previews could not be loaded', () => {
    previews.value = { status: 'error', error: 'nope', previews: new Map(), recentAuthors: new Map() };
    renderPanel();
    expect(within(screen.getByRole('link', { name: /Clips/ })).getByText('Preview unavailable')).toBeInTheDocument();
  });
});

describe('PlacesPanel: keyboard', () => {
  it('has one Tab stop in the list, on the open channel, and one in the server row', () => {
    renderPanel();
    const listStops = screen
      .getAllByRole('link')
      .filter((link) => link.hasAttribute('data-place-row') && link.getAttribute('tabindex') === '0');
    expect(listStops).toHaveLength(1);
    expect(listStops[0]).toHaveAttribute('data-row-id', 'channel:general');
    const serverStops = within(screen.getByRole('navigation', { name: 'Servers' }))
      .getAllByRole('button')
      .filter((button) => button.getAttribute('tabindex') === '0');
    expect(serverStops).toHaveLength(1);
    expect(serverStops[0]).toHaveAccessibleName(/^Game Night/);
  });

  it('moves through the rows with the arrow keys and lands on the last and first with End and Home', () => {
    renderPanel();
    const general = screen.getByRole('link', { name: /General/ });
    general.focus();
    fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(screen.getByRole('link', { name: /Lounge/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(screen.getByRole('link', { name: /Clips/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(screen.getByRole('link', { name: /Lounge/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(screen.getByRole('link', { name: /Patch notes/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(general).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(screen.getByRole('link', { name: /Patch notes/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(general).toHaveFocus();
  });

  it('follows focus: the row you focused becomes the Tab stop', () => {
    renderPanel();
    const clips = screen.getByRole('link', { name: /Clips/ });
    act(() => clips.focus());
    expect(clips).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('link', { name: /General/ })).toHaveAttribute('tabindex', '-1');
  });

  it('opens a row with Space as well as Enter', () => {
    renderPanel();
    const clips = screen.getByRole('link', { name: /Clips/ });
    clips.focus();
    fireEvent.keyDown(clips, { key: ' ' });
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/clips');
  });
});

describe('PlacesPanel: Home', () => {
  it('lists conversations in the same row style, under Friends, with the tray as the current place', async () => {
    vi.mocked(useUnifiedConversations).mockReturnValue(
      conversations({
        recent: [entry(), entry({ key: entityScopeKey(SCOPE, 'dm-2'), channelId: 'dm-2', title: 'Nick', userId: 'nick', isDMUnread: false, lastActivityId: idAt(NOW - 2 * 24 * 3600_000) })],
        requests: [{ key: 'request:9', userId: '9', username: 'Ren', createdMs: NOW }],
      }),
    );
    renderPanel('/app');
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('1 unread, 1 request')).toBeInTheDocument();
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    const rows = within(list).getAllByRole('link').map((link) => link.getAttribute('data-row-id'));
    expect(rows).toEqual(['home:friends', expect.stringContaining('dm:'), expect.stringContaining('dm:')]);
    const brendan = within(list).getByRole('link', { name: /Brendan/ });
    expect(brendan).toHaveTextContent('you around for the run?');
    expect(brendan).toHaveTextContent('8:55 PM');
    // Unread, and the count arrives from the server.
    await waitFor(() => expect(within(brendan).getByText('3')).toHaveAttribute('data-tone', 'count'));
    expect(brendan).toHaveAttribute('href', '/app/dms/dm-1');
    // The tray is the current place in Home.
    expect(screen.getByRole('button', { name: /Home and direct messages/ })).toHaveAttribute('aria-current', 'true');
    // The friend request is a white count on Friends.
    expect(within(within(list).getByRole('link', { name: /Friends/ })).getByText('1')).toHaveAttribute('data-tone', 'mention');
  });

  it('opens a conversation, and Friends', () => {
    vi.mocked(useUnifiedConversations).mockReturnValue(conversations({ recent: [entry()] }));
    renderPanel('/app');
    fireEvent.click(screen.getByRole('link', { name: /Brendan/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/dms/dm-1');
    fireEvent.click(screen.getByRole('link', { name: /Friends/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/friends');
  });

  it('counts unread conversations and requests on the tray only when you are inside a server', () => {
    vi.mocked(useUnifiedConversations).mockReturnValue(
      conversations({ recent: [entry(), entry({ key: entityScopeKey(SCOPE, 'dm-2'), channelId: 'dm-2', title: 'Nick' })] }),
    );
    const { unmount } = renderPanel('/app/guilds/g1/channels/general');
    expect(screen.getByRole('button', { name: 'Home and direct messages, 2 unread' })).toBeInTheDocument();
    unmount();
    renderPanel('/app');
    expect(screen.getByRole('button', { name: 'Home and direct messages' })).toBeInTheDocument();
  });

  it('says there is nothing yet, rather than showing an empty list', () => {
    renderPanel('/app');
    expect(screen.getByText('Your direct messages will appear here.')).toBeInTheDocument();
  });

  it('marks the open conversation', () => {
    vi.mocked(useUnifiedConversations).mockReturnValue(conversations({ recent: [entry()] }));
    renderPanel('/app/dms/dm-1');
    expect(screen.getByRole('link', { name: /Brendan/ })).toHaveAttribute('aria-current', 'page');
  });
});
