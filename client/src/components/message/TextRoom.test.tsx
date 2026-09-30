import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TopBar } from '../layout/TopBar';
import { DayDivider, MessageActions, ReplyChip, RoomLitEventRow, ThreadRow, TimelineAvatar, dayDividerLabel, isToday, timelineTime, typingSentence } from './TimelineParts';
import { composerPlaceholder } from './MessageInput';
import { personLight } from '../../lib/attention/light';

/**
 * WP5 — the text room and the DM (docs/lantern-stage-spec.md §7.4, §7.6).
 *
 * Four things this package promises, each checked against the words the spec
 * puts on the surface rather than against a class name:
 *
 *   1. the header strip says "5 here · 19 online" and there is no member
 *      list anywhere near it (§6.5, §7.4);
 *   2. a message's face and its hover actions (docs/glass-spec.md §3.2);
 *   3. a room that lights up while you are reading appears in the timeline as
 *      an event, and disappears again when it empties (§7.4);
 *   4. the composer says where the message goes: "Message #general"
 *      (docs/server-home-spec.md, "Plain words").
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
      caption: `${readers.length} here · 19 online`,
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

  it('says how many people are here, and how many are online', async () => {
    renderTextRoomHeader();
    expect(await screen.findByText('5 here')).toBeVisible();
    expect(screen.getByText(/19 online/)).toBeVisible();
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
    expect(screen.getByRole('button', { expanded: false, name: /here/ })).toBeInTheDocument();
  });

  it('carries the pins count on the pins control', async () => {
    renderTextRoomHeader();
    const pins = await screen.findByRole('button', { name: 'Pinned messages' });
    await waitFor(() => expect(pins).toHaveTextContent('2'));
  });
});

/* ---------------------------------------------------------------------------
 * 2. A message's face and actions (docs/glass-spec.md §3.2)
 * ------------------------------------------------------------------------- */

describe('a message author in the Glass timeline', () => {
  it('draws a plain 32px face with the author\'s initials when there is no photo', () => {
    const { container } = render(<TimelineAvatar userId="u1" name="Mara Okonkwo" />);
    const face = container.querySelector('.glass-tl-avatar') as HTMLElement;
    expect(face).toHaveTextContent('MO');
    expect(face.style.width).toBe('32px');
    // The reference draws no presence ring on a timeline face.
    expect(face.className).not.toMatch(/pc-lit|pc-speaking|pc-dim/);
  });

  it('offers react, reply and more as named buttons, and says when more is open', () => {
    const onReact = vi.fn();
    const onReply = vi.fn();
    const onMore = vi.fn();
    render(<MessageActions authorName="Brendan" onReact={onReact} onReply={onReply} onMore={onMore} moreExpanded />);
    screen.getByRole('button', { name: 'React to Brendan' }).click();
    screen.getByRole('button', { name: 'Reply to Brendan' }).click();
    const more = screen.getByRole('button', { name: 'More actions' });
    more.click();
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it('leaves out the actions the reader may not take', () => {
    render(<MessageActions authorName="Brendan" onMore={vi.fn()} moreExpanded={false} />);
    expect(screen.queryByRole('button', { name: /React to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reply to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('says who is typing in words', () => {
    expect(typingSentence(['Eric'])).toBe('Eric is typing');
    expect(typingSentence(['Eric', 'Nick'])).toBe('Eric and Nick are typing');
    expect(typingSentence(['Eric', 'Nick', 'Luke'])).toBe('Eric, Nick, and Luke are typing');
    expect(typingSentence(['a', 'b', 'c', 'd'])).toBe('4 people are typing');
    expect(typingSentence([])).toBe('');
  });

  it('writes the time in the locale\'s own form', () => {
    const iso = '2026-10-01T21:02:00';
    const expected = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    expect(timelineTime(iso)).toBe(expected);
    expect(timelineTime('not a date')).toBe('not a date');
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

describe('the composer says where the message goes (plain words)', () => {
  it('names the channel, the group or the person', () => {
    expect(composerPlaceholder('general')).toBe('Message general');
    expect(composerPlaceholder('Ade, Jonas', 'group')).toBe('Message Ade, Jonas');
    expect(composerPlaceholder('Mara', 'person')).toBe('Message Mara');
  });

  it('has a phone form that drops a name too long to fit', () => {
    expect(composerPlaceholder('build-log', 'channel', true)).toBe('Message build-log');
    // A channel name can be any length, so past what fits the name is dropped.
    expect(composerPlaceholder('a-very-long-channel-name-indeed', 'channel', true)).toBe('Write a message');
    for (const name of ['general', 'build-log', 'a-very-long-channel-name-indeed']) {
      expect(composerPlaceholder(name, 'channel', true).length).toBeLessThanOrEqual(26);
    }
  });

  it('asks for a message when it has no name to give', () => {
    expect(composerPlaceholder()).toBe('Write a message');
    expect(composerPlaceholder(null, 'person')).toBe('Write a message');
  });

  it('never counts who is reading', () => {
    for (const copy of [composerPlaceholder('build-log'), composerPlaceholder('Mara', 'person'), composerPlaceholder()]) {
      expect(copy).not.toMatch(/reading|people|person/);
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

  it('knows today from any other day', () => {
    const now = new Date('2026-05-17T12:00:00').getTime();
    expect(isToday('2026-05-17T00:30:00', now)).toBe(true);
    expect(isToday('2026-05-16T23:30:00', now)).toBe(false);
    expect(isToday('garbage', now)).toBe(false);
  });

  it('renders the day as a centered kicker that names itself', () => {
    render(<DayDivider label="Today" />);
    expect(screen.getByText('Today')).toBeVisible();
    expect(screen.getByRole('separator', { name: 'Today' })).toBeInTheDocument();
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
