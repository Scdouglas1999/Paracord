import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TopBar } from '../layout/TopBar';
import { AuthorMeta, DayDivider, ReplyChip, RoomLitEventRow, ThreadRow, dayDividerLabel } from './TimelineParts';
import { composerPlaceholder } from './MessageInput';
import { personLight } from '../../lib/attention/light';

/**
 * WP5 — the text room and the DM (docs/lantern-stage-spec.md §7.4, §7.6).
 *
 * Four things this package promises, each checked against the words the spec
 * puts on the surface rather than against a class name:
 *
 *   1. the header strip says "5 reading · 19 lights on" and there is no member
 *      list anywhere near it (§6.5, §7.4);
 *   2. a message's meta says "in Shop floor · 9:12 AM" when its author is in a
 *      room right now, and only then (§7.4);
 *   3. a room that lights up while you are reading appears in the timeline as
 *      an event, and disappears again when it empties (§7.4);
 *   4. the composer invites the people who will read it, and falls back to the
 *      room when nobody else is there (§6.9, §7.4).
 */

/* ---------------------------------------------------------------------------
 * 1. The header strip
 * ------------------------------------------------------------------------- */

const mockUIState = vi.hoisted(() => ({
  contextPanelMode: null as string | null,
  toggleContextPanelMode: vi.fn(),
  setContextPanelMode: vi.fn(),
  setSidebarCollapsed: vi.fn(),
  sidebarCollapsed: false,
  setGuildSettingsId: vi.fn(),
  connectionStatus: 'connecting',
  connectionLatency: 42,
}));

const readers = vi.hoisted(() => ['Mara', 'Tomas', 'Aisha', 'Priya', 'Ren']);

vi.mock('../../hooks/useLights', async () => {
  const stub = await import('../../test/messageLightMock');
  const { personLight: build } = await import('../../lib/attention/light');
  return {
    ...stub,
    useHereNow: () => ({
      people: readers.map((name, index) =>
        build({ userId: `u${index}`, name, status: 'online' }),
      ),
      here: readers.length,
      lightsOn: 19,
      caption: `${readers.length} here · 19 lights on`,
    }),
    useRoomLight: () => ({ lit: true, kind: 'text' }),
  };
});
vi.mock('./messageLight', () => import('../../test/messageLightMock'));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (state: typeof mockUIState) => unknown) => selector(mockUIState),
    { getState: () => mockUIState },
  ),
}));
vi.mock('../../hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 'me', username: 'me' }),
  useCurrentAccountScope: () => ({ serverId: '__local__', userId: 'me' }),
}));
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: false, isOwner: false, isLoading: false }),
}));
vi.mock('../../stores/channelStore', () => ({
  useChannelStore: Object.assign(
    (selector: (state: { channelsByGuild: Record<string, unknown[]>; channelsById: Record<string, unknown> }) => unknown) =>
      selector({ channelsByGuild: {}, channelsById: {} }),
    { getState: () => ({ channelsByGuild: {}, channelsById: {} }) },
  ),
}));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: Object.assign(
    (selector: (state: { systemAudioCaptureActive: boolean }) => unknown) =>
      selector({ systemAudioCaptureActive: false }),
    { getState: () => ({ systemAudioCaptureActive: false }) },
  ),
}));
vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({ connected: false, channelId: null, joinChannel: vi.fn(), leaveChannel: vi.fn() }),
}));
vi.mock('../../api/channels', () => ({
  channelApi: {
    getPins: vi.fn().mockResolvedValue({ data: [{ id: 'p1' }, { id: 'p2' }] }),
    summarizeChannel: vi.fn(),
    getFollowers: vi.fn(),
    addFollower: vi.fn(),
    removeFollower: vi.fn(),
  },
}));
vi.mock('../../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useChannels')>('../../hooks/useChannels');
  const { useChannelStore } = await import('../../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore((state) => state.channelsByGuild[id] ?? []),
  };
});
vi.mock('../../hooks/useConversationActions', () => ({
  useConversationActions: () => ({
    actions: Object.fromEntries(
      ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'].map(
        (action) => [action, { supported: true, allowed: true, reason: null }],
      ),
    ),
    encrypted: false,
    encryption: 'ready',
    error: null,
    loading: false,
    refresh: vi.fn(),
  }),
}));

function renderTextRoomHeader() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/guild-1/channels/channel-1']}>
      <Routes>
        <Route
          path="/app/guilds/:guildId/channels/:channelId"
          element={<TopBar channelName="build-log" channelTopic="Hardware bring-up" guildId="guild-1" guildName="Kestrel Robotics" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the text room header (§7.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUIState.contextPanelMode = null;
  });

  it('says how many people are reading, and how many have their lights on', async () => {
    renderTextRoomHeader();
    expect(await screen.findByText('5 reading')).toBeVisible();
    expect(screen.getByText(/19 lights on/)).toBeVisible();
  });

  it('names the server and the topic beside the room, and the server is the way back', () => {
    renderTextRoomHeader();
    expect(screen.getByRole('button', { name: 'Go to Kestrel Robotics home' })).toBeInTheDocument();
    expect(screen.getByText(/· Hardware bring-up/)).toBeInTheDocument();
  });

  it('offers the people sheet rather than a docked member list (§6.5)', () => {
    renderTextRoomHeader();
    expect(screen.queryByRole('button', { name: 'Member List' })).not.toBeInTheDocument();
    // The strip itself is the way to the only full list in the product.
    expect(screen.getByRole('button', { expanded: false, name: /reading/ })).toBeInTheDocument();
  });

  it('carries the pins count on the pins control', async () => {
    renderTextRoomHeader();
    const pins = await screen.findByRole('button', { name: 'Pinned messages' });
    await waitFor(() => expect(pins).toHaveTextContent('2'));
  });
});

/* ---------------------------------------------------------------------------
 * 2. "in Shop floor · 9:12 AM"
 * ------------------------------------------------------------------------- */

describe('a message author, as light (§7.4)', () => {
  it('says which room the author is in when they are in one right now', () => {
    const person = personLight({
      userId: 'u1',
      name: 'Mara Okonkwo',
      status: 'online',
      inRoom: true,
      roomName: 'Shop floor',
    });
    render(<AuthorMeta person={person} timestamp="9:12 AM" />);
    expect(screen.getByText('in Shop floor')).toBeVisible();
    expect(screen.getByText('9:12 AM')).toBeVisible();
  });

  it('says only the time when the author is in no room', () => {
    const person = personLight({ userId: 'u1', name: 'Mara Okonkwo', status: 'online' });
    render(<AuthorMeta person={person} timestamp="9:12 AM" />);
    expect(screen.queryByText(/^in /)).not.toBeInTheDocument();
    expect(screen.getByText('9:12 AM')).toBeVisible();
    // §9: the rim is a light state, so it still says its words somewhere.
    expect(screen.getByText('Lights on')).toBeInTheDocument();
  });

  it('never claims a room for somebody whose lights are off', () => {
    const person = personLight({
      userId: 'u1',
      name: 'Mara Okonkwo',
      status: 'offline',
      roomName: 'Shop floor',
    });
    render(<AuthorMeta person={person} timestamp="9:12 AM" />);
    expect(screen.queryByText('in Shop floor')).not.toBeInTheDocument();
  });
});

/* ---------------------------------------------------------------------------
 * 3. A room lighting up, in the timeline
 * ------------------------------------------------------------------------- */

describe('a room lighting up, in the timeline (§7.4)', () => {
  it('draws the event as a lit window, a sentence and one action', () => {
    const onJoin = vi.fn();
    render(
      <RoomLitEventRow
        event={{
          key: 'k',
          channelId: 'voice-1',
          guildId: 'guild-1',
          roomName: 'Shop floor',
          headline: 'Shop floor lit up',
          detail: 'Mara, Priya and Ren are in there now',
          atMs: 0,
        }}
        onJoin={onJoin}
      />,
    );
    const event = screen.getByTestId('room-lit-event');
    expect(event).toHaveTextContent('Shop floor lit up · Mara, Priya and Ren are in there now');
    screen.getByRole('button', { name: 'Join' }).click();
    expect(onJoin).toHaveBeenCalledTimes(1);
  });
});

/* ---------------------------------------------------------------------------
 * 4. The composer's copy, and the rest of the timeline's small shapes
 * ------------------------------------------------------------------------- */

describe('the composer invites people, not a channel (§6.9, §7.4)', () => {
  it('names the people who will read it', () => {
    expect(composerPlaceholder(5, 'build-log')).toBe('Say something to the 5 people reading');
    expect(composerPlaceholder(1, 'build-log')).toBe('Say something to the 1 person reading');
  });

  it('falls back to the room when nobody else is here', () => {
    expect(composerPlaceholder(0, 'build-log')).toBe('Say something in build-log');
  });

  it('never says "Message #channel"', () => {
    for (const copy of [composerPlaceholder(0, 'build-log'), composerPlaceholder(3, 'build-log'), composerPlaceholder(0)]) {
      expect(copy).not.toMatch(/^Message /);
      expect(copy).not.toContain('#');
    }
  });
});

describe('the timeline’s small shapes (§7.4)', () => {
  it('labels a day divider with a word where there is one', () => {
    const now = new Date('2026-05-17T12:00:00.000Z').getTime();
    expect(dayDividerLabel('2026-05-17T09:00:00.000Z', now)).toBe('Today');
    expect(dayDividerLabel('2026-05-16T09:00:00.000Z', now)).toBe('Yesterday');
    expect(dayDividerLabel('2026-01-02T09:00:00.000Z', now)).toMatch(/January/);
  });

  it('renders the divider chip', () => {
    render(<DayDivider label="Today" />);
    expect(screen.getByText('Today')).toBeVisible();
  });

  it('names who is being answered on a reply chip', () => {
    const onJump = vi.fn();
    render(<ReplyChip author="Mara" preview="Driver board v3 came back…" onJump={onJump} />);
    screen.getByRole('button', { name: /Mara/ }).click();
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('puts a thread’s faces, name and reply count on one row', () => {
    render(
      <ThreadRow
        name="Firmware flash sequence"
        meta="4 replies · 12 min ago"
        people={[personLight({ userId: 'u1', name: 'Tomas', status: 'online' })]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('Firmware flash sequence')).toBeVisible();
    expect(screen.getByText('4 replies · 12 min ago')).toBeVisible();
    expect(screen.getByText('Open thread')).toBeVisible();
  });
});
