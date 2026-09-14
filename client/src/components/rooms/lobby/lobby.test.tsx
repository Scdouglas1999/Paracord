import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { AddRoomTile, RoomCard } from './RoomCard';
import { TextRoomRow } from './TextRoomRow';
import { EventCard } from './EventCard';
import { MediaStrip } from './MediaStrip';
import { AroundNowWell } from './AroundNowWell';
import { LobbyHeader } from './LobbyHeader';
import { featuredFirst, readHubWelcome } from './hubWelcome';
import { nextEventOf, toLobbyEvent, type LobbyEvent } from './useNextEvent';
import { selectRecentMedia } from './useRecentMedia';
import { toPreview } from './useRoomPreviews';
import { personLight, textRoomLight, voiceRoomLight } from '../../../lib/attention/light';
import type { Attachment, Message } from '../../../types';

// The strip's tiles fetch their bytes through the authenticated blob path; in
// jsdom that is the one thing we stub, so the tests exercise the selection rules
// and the markup rather than axios.
vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:lobby-test') },
}));

const SCOPE = { serverId: 'srv-1', userId: 'viewer' };
const NOW = new Date('2026-09-13T15:00:00Z').getTime();

function person(id: string, name: string, over: Partial<Parameters<typeof personLight>[0]> = {}) {
  return personLight({ userId: id, name, status: 'online', ...over });
}

function litRoom(over: { speaking?: boolean; sharing?: boolean } = {}) {
  return voiceRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId: 'v1',
    name: 'Shop floor',
    occupants: [
      {
        person: person('1', 'Mara', { speaking: over.speaking, inRoom: true, roomName: 'Shop floor' }),
        speaking: over.speaking ?? false,
        sharingScreen: over.sharing ?? false,
      },
      { person: person('2', 'Priya', { inRoom: true, roomName: 'Shop floor' }) },
    ],
    startedAtMs: NOW - 34 * 60_000,
    nowMs: NOW,
  });
}

function darkRoom(lastLitMs: number | null = NOW - 2 * 60 * 60_000) {
  return voiceRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId: 'v2',
    name: 'Lounge',
    occupants: [],
    lastLitMs,
    nowMs: NOW,
  });
}

function textRoom(lit: boolean) {
  const readers = lit ? [person('3', 'Tomas'), person('4', 'Aisha')] : [];
  return textRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId: 't1',
    name: 'build-log',
    candidates: readers,
    typingUserIds: readers.map((reader) => reader.userId),
    nowMs: NOW,
  });
}

afterEach(() => cleanup());

/* -------------------------------------------------------------------------- */
/* RoomCard — the three things in the grid (§7.3)                              */
/* -------------------------------------------------------------------------- */

describe('RoomCard — lit', () => {
  it('carries the lit ring, the LIVE label, who is speaking, and a white-light Join', () => {
    const onJoin = vi.fn();
    const { container } = render(
      <RoomCard room={litRoom({ speaking: true, sharing: true })} onJoin={onJoin} nowMs={NOW} />,
    );

    // The ring is the plate's lit recipe, from a token — not a style choice.
    expect(container.querySelector('article')?.className).toContain('--ring-lit-plate');
    // §9: the light always has its words in the DOM.
    expect(screen.getByText('LIVE · Mara is sharing a screen')).toBeInTheDocument();
    expect(screen.getByText('Mara speaking')).toBeInTheDocument();
    expect(screen.getByText('Mara and Priya in Shop floor')).toBeInTheDocument();

    const join = screen.getByRole('button', { name: 'Join Shop floor' });
    expect(join.className).toContain('bg-light-white');
    fireEvent.click(join);
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('falls back to the room caption when nobody is talking', () => {
    render(<RoomCard room={litRoom()} onJoin={vi.fn()} nowMs={NOW} />);
    expect(screen.getByText('2 in')).toBeInTheDocument();
    expect(screen.queryByText(/speaking/)).not.toBeInTheDocument();
  });

  it('offers a way to look into the room when there is something to look at', () => {
    const onEnter = vi.fn();
    render(<RoomCard room={litRoom({ sharing: true })} onEnter={onEnter} onJoin={vi.fn()} nowMs={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Look into Shop floor' }));
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});

describe('RoomCard — dark', () => {
  it('says it is dark, remembers when it was last lit, and offers to open it', () => {
    const onJoin = vi.fn();
    const { container } = render(<RoomCard room={darkRoom()} onJoin={onJoin} nowMs={NOW} />);

    expect(container.querySelector('article')?.className).not.toContain('--ring-lit-plate');
    expect(screen.getByText("Dark · nobody's in · last lit 2 h ago")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Lounge' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('says "never lit" rather than inventing an hour it has not seen', () => {
    render(<RoomCard room={darkRoom(null)} onJoin={vi.fn()} nowMs={NOW} />);
    expect(screen.getByText("Dark · nobody's in · never lit")).toBeInTheDocument();
  });

  it('reserves no window well for a picture that does not exist', () => {
    // The defect this replaces: a never-lit room drew the lit card's full
    // 168px RoomThumbnail and filled it with nothing, so a quiet building's
    // Lobby was a column of empty black rectangles (§7.3, §6.4, §6.8).
    const { container } = render(<RoomCard room={darkRoom()} onJoin={vi.fn()} nowMs={NOW} />);
    const boxes = [...container.querySelectorAll<HTMLElement>('[style]')].map(
      (node) => node.style.height,
    );
    expect(boxes).not.toContain('168px');
    // The room is still marked with the window vocabulary, all panes unlit.
    const panes = container.querySelectorAll('.pc-window');
    expect(panes.length).toBeGreaterThan(0);
    for (const pane of panes) {
      expect(pane.className).not.toMatch(/is-(talking|reading|writing)/);
    }
  });

  it('has nothing to look into', () => {
    render(<RoomCard room={darkRoom()} onEnter={vi.fn()} onJoin={vi.fn()} nowMs={NOW} />);
    expect(screen.queryByRole('button', { name: /Look into/ })).not.toBeInTheDocument();
  });
});

describe('AddRoomTile', () => {
  it('is one action and nothing else', () => {
    const onClick = vi.fn();
    render(<AddRoomTile onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open a new room' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* TextRoomRow (§8)                                                            */
/* -------------------------------------------------------------------------- */

describe('TextRoomRow', () => {
  it('lights the window dot amber and names the readers when somebody is in', () => {
    const { container } = render(
      <TextRoomRow
        room={textRoom(true)}
        lastAuthor="Priya"
        lastAt="10:02"
        preview="thermal rig is booked 1–3 pm"
        mentionCount={1}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector('.pc-window')?.className).toContain('is-reading');
    expect(screen.getByText('2 reading')).toBeInTheDocument();
    expect(screen.getByText('1 mention')).toBeInTheDocument();
    expect(screen.getByText('Priya · 10:02')).toBeInTheDocument();
    expect(screen.getByText('thermal rig is booked 1–3 pm')).toBeInTheDocument();
  });

  it('leaves the dot dark and says nothing about readers when nobody is in', () => {
    const { container } = render(<TextRoomRow room={textRoom(false)} onOpen={vi.fn()} />);
    expect(container.querySelector('.pc-window')?.className).not.toContain('is-reading');
    expect(screen.queryByText(/reading/)).not.toBeInTheDocument();
  });

  it('says a room nobody has written in is empty, rather than drawing three blanks', () => {
    render(<TextRoomRow room={textRoom(false)} silent onOpen={vi.fn()} />);
    expect(screen.getByText('Nothing said here yet')).toBeInTheDocument();
  });

  it('shows no preview for a room this client has never opened', () => {
    render(<TextRoomRow room={textRoom(false)} onOpen={vi.fn()} />);
    // The name is all we can honestly say about an unloaded room.
    expect(screen.getByRole('button').textContent).toContain('build-log');
    expect(screen.getByRole('button').textContent).not.toMatch(/·/);
  });

  it('raises the active row and marks it as the current page', () => {
    render(<TextRoomRow room={textRoom(true)} active onOpen={vi.fn()} />);
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(row.className).toContain('bg-bg-raised');
  });

  it('marks unread traffic in words as well as with a dot', () => {
    render(<TextRoomRow room={textRoom(false)} unread onOpen={vi.fn()} />);
    expect(screen.getByText('Unread')).toBeInTheDocument();
  });

  it('opens the room', () => {
    const onOpen = vi.fn();
    render(<TextRoomRow room={textRoom(true)} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('has no menu control when the surface offers no menu', () => {
    render(<TextRoomRow room={textRoom(true)} onOpen={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The room menu's second door (§7.1) — a phone never renders the Buildings    */
/* column, so the Lobby's rows and cards carry it too.                         */
/* -------------------------------------------------------------------------- */

describe('the room menu on the Lobby', () => {
  it('opens from a long press and from a visible control on a text row', () => {
    const onMenu = vi.fn();
    const onOpen = vi.fn();
    render(<TextRoomRow room={textRoom(true)} onOpen={onOpen} onMenu={onMenu} />);

    // Chromium raises `contextmenu` after a long touch press, which is the
    // gesture a phone has instead of a right-click.
    const [rowButton] = screen.getAllByRole('button');
    fireEvent.contextMenu(rowButton);
    expect(onMenu).toHaveBeenCalledTimes(1);

    // …and the affordance a first-time reader can actually see.
    const control = screen.getByRole('button', { name: 'Room options for build-log' });
    expect(control.className).toContain('pc-touch');
    fireEvent.click(control);
    expect(onMenu).toHaveBeenCalledTimes(2);
    // Opening the menu is not opening the room.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens from a lit card and a dark one', () => {
    const onMenu = vi.fn();
    const { container, rerender } = render(
      <RoomCard room={litRoom()} onJoin={vi.fn()} onMenu={onMenu} nowMs={NOW} />,
    );
    fireEvent.contextMenu(container.querySelector('article')!);
    fireEvent.click(screen.getByRole('button', { name: 'Room options for Shop floor' }));
    expect(onMenu).toHaveBeenCalledTimes(2);

    rerender(<RoomCard room={darkRoom()} onJoin={vi.fn()} onMenu={onMenu} nowMs={NOW} />);
    fireEvent.contextMenu(container.querySelector('article')!);
    fireEvent.click(screen.getByRole('button', { name: 'Room options for Lounge' }));
    expect(onMenu).toHaveBeenCalledTimes(4);
  });

  it('leaves the cards alone when no menu is offered', () => {
    render(<RoomCard room={darkRoom()} onJoin={vi.fn()} nowMs={NOW} />);
    expect(screen.queryByRole('button', { name: /Room options/ })).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Coming up and the media strip (§7.3)                                        */
/* -------------------------------------------------------------------------- */

const EVENT: LobbyEvent = {
  id: 'e1',
  name: 'Thermal test — driver v3',
  startsAt: new Date('2026-09-13T13:00:00'),
  channelId: 'v1',
  location: null,
  creatorId: '2',
  going: 6,
  youAreGoing: false,
};

describe('EventCard', () => {
  it('draws the day tile and one line of facts, with one action', () => {
    const onRsvp = vi.fn();
    render(
      <EventCard event={EVENT} where="Shop floor" host="Priya" onRsvp={onRsvp} nowMs={NOW} />,
    );
    expect(screen.getByText('Thermal test — driver v3')).toBeInTheDocument();
    const meta = screen.getByText(/Shop floor/);
    expect(meta.textContent).toContain('Today');
    expect(meta.textContent).toContain('Priya is hosting');
    expect(meta.textContent).toContain('6 going');

    const rsvp = screen.getByRole('button', { name: "I'm going" });
    expect(rsvp).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(rsvp);
    expect(onRsvp).toHaveBeenCalledTimes(1);
  });

  it('drops the clauses it cannot fill instead of printing an empty one', () => {
    render(<EventCard event={{ ...EVENT, going: 0 }} host={null} onRsvp={vi.fn()} nowMs={NOW} />);
    const meta = screen.getByText(/Today/);
    expect(meta.textContent).not.toContain('hosting');
    expect(meta.textContent).not.toContain('going');
    expect(meta.textContent).not.toMatch(/·\s*·/);
  });

  it('reflects an RSVP the reader has already made', () => {
    render(<EventCard event={{ ...EVENT, youAreGoing: true }} onRsvp={vi.fn()} nowMs={NOW} />);
    expect(screen.getByRole('button', { name: "You're going" })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('MediaStrip', () => {
  const item = (id: string) => ({
    key: `t1:${id}`,
    channelId: 't1',
    attachment: { id, filename: `${id}.png`, size: 1, url: `/attachments/${id}`, content_type: 'image/png' } as Attachment,
    atMs: NOW,
    authorName: 'Mara',
  });

  it('names the building, the sharer and the week count', () => {
    render(
      <MediaStrip
        buildingName="Kestrel Robotics"
        items={[item('a'), item('b')]}
        weekCount={14}
        onOpen={vi.fn()}
      />,
    );
    const strip = screen.getByRole('region', { name: 'Recently in Kestrel Robotics' });
    expect(within(strip).getByText('14 photos this week')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'a.png — shared by Mara' })).toBeInTheDocument();
  });

  it('opens the room an image was shared in', () => {
    const onOpen = vi.fn();
    render(
      <MediaStrip buildingName="Kestrel" items={[item('a')]} weekCount={1} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'a.png — shared by Mara' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Around now and the header                                                   */
/* -------------------------------------------------------------------------- */

describe('AroundNowWell', () => {
  it('draws a face for every lit person beside the sentence', () => {
    // The defect this replaces: the well was fed only people who were *in a
    // room*, so a building where somebody had the app open but was in no room
    // drew an empty strip beside a bare "+1 lights on" chip.
    render(
      <AroundNowWell
        people={[person('1', 'Mara'), person('2', 'Priya')]}
        sentence="Mara has their lights on"
        lightsOn={2}
      />,
    );
    const well = screen.getByRole('region', { name: 'Around now' });
    expect(within(well).getByText('Mara and Priya around now')).toBeInTheDocument();
    expect(within(well).queryByText(/^\+\d+ lights on$/)).toBeNull();
  });

  it('shows the faces, the sentence and everybody else who is on', () => {
    render(
      <AroundNowWell
        people={[person('1', 'Mara'), person('2', 'Priya')]}
        sentence="Mara and Priya are in Shop floor"
        lightsOn={24}
      />,
    );
    const well = screen.getByRole('region', { name: 'Around now' });
    expect(within(well).getByText('Mara and Priya are in Shop floor')).toBeInTheDocument();
    expect(within(well).getByText('+22 lights on')).toBeInTheDocument();
  });

  it('drops the overflow count rather than printing "+0 lights on"', () => {
    render(
      <AroundNowWell
        people={[person('1', 'Mara')]}
        sentence="Mara is in Shop floor"
        lightsOn={1}
      />,
    );
    expect(screen.queryByText(/lights on/)).not.toBeInTheDocument();
  });
});

describe('LobbyHeader', () => {
  it('offers invite and settings only when the caller allows them', () => {
    const { rerender } = render(
      <LobbyHeader guildId="g1" name="Kestrel Robotics" summary="24 of 61 have their lights on" />,
    );
    expect(screen.getByRole('heading', { name: 'Kestrel Robotics' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite people' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Building settings' })).not.toBeInTheDocument();

    const onInvite = vi.fn();
    const onSettings = vi.fn();
    rerender(
      <LobbyHeader
        guildId="g1"
        name="Kestrel Robotics"
        summary="24 of 61 have their lights on"
        onInvite={onInvite}
        onSettings={onSettings}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }));
    fireEvent.click(screen.getByRole('button', { name: 'Building settings' }));
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* What the building's operator wrote about it (§7.3, hubWelcome.ts)           */
/* -------------------------------------------------------------------------- */

describe('the operator’s welcome line', () => {
  it('is the header’s sentence when they wrote one, and the generated one stays for a screen reader', () => {
    render(
      <LobbyHeader
        guildId="g1"
        name="Kestrel Robotics"
        summary="24 of 61 have their lights on · 2 rooms lit"
        welcome="Bring a part, leave with a part."
      />,
    );
    const written = screen.getByText('Bring a part, leave with a part.');
    expect(written).toBeVisible();
    expect(written.className).not.toContain('sr-only');
    // §9: the light's words are not lost with it.
    expect(screen.getByText('24 of 61 have their lights on · 2 rooms lit').className).toContain('sr-only');
  });

  it('leaves the generated sentence alone when the operator wrote nothing', () => {
    render(
      <LobbyHeader guildId="g1" name="Kestrel Robotics" summary="2 rooms lit" welcome="   " />,
    );
    const generated = screen.getByText('2 rooms lit');
    expect(generated).toBeVisible();
    expect(generated.className).not.toContain('sr-only');
  });
});

describe('readHubWelcome', () => {
  it('reads nothing out of nothing', () => {
    expect(readHubWelcome(null)).toEqual({ welcome: '', bannerSrc: null, featuredChannelIds: [] });
    expect(readHubWelcome(undefined).welcome).toBe('');
  });

  it('prefers the greeting over the blurb and collapses it to one line', () => {
    expect(
      readHubWelcome({ welcome_text: '  Bring a part,\n leave  with a part. ', description: 'A workshop' })
        .welcome,
    ).toBe('Bring a part, leave with a part.');
    expect(readHubWelcome({ description: 'A workshop' }).welcome).toBe('A workshop');
  });

  it('refuses a banner that is not a picture it can prove is safe', () => {
    expect(readHubWelcome({ banner_hash: 'javascript:alert(1)' }).bannerSrc).toBeNull();
    expect(readHubWelcome({ banner_hash: 42 as unknown as string }).bannerSrc).toBeNull();
  });

  it('keeps only the channel ids that are strings', () => {
    expect(
      readHubWelcome({ pinned_channels: ['t2', 7 as unknown as string, 't1'] }).featuredChannelIds,
    ).toEqual(['t2', 't1']);
  });
});

describe('featuredFirst', () => {
  const rooms = [{ channelId: 'a' }, { channelId: 'b' }, { channelId: 'c' }];

  it('leaves the order alone when nothing is featured', () => {
    expect(featuredFirst(rooms, []).map((room) => room.channelId)).toEqual(['a', 'b', 'c']);
  });

  it('puts featured rooms first, in the order the operator chose them', () => {
    expect(featuredFirst(rooms, ['c', 'b']).map((room) => room.channelId)).toEqual(['c', 'b', 'a']);
  });

  it('ignores a featured id for a room that is not here', () => {
    expect(featuredFirst(rooms, ['zz', 'b']).map((room) => room.channelId)).toEqual(['b', 'a', 'c']);
  });
});

describe('a featured text room', () => {
  it('says it is featured without spending a light token on it', () => {
    const { container } = render(
      <TextRoomRow room={textRoom(false)} featured onOpen={() => {}} />,
    );
    expect(screen.getByText('Featured by this building')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('light-white');
    expect(container.innerHTML).not.toContain('light-amber');
  });

  it('says nothing when it is an ordinary room', () => {
    render(<TextRoomRow room={textRoom(false)} onOpen={() => {}} />);
    expect(screen.queryByText('Featured by this building')).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* The selection rules behind the two optional sections                        */
/* -------------------------------------------------------------------------- */

describe('what counts as coming up', () => {
  const base = {
    id: 'e1',
    name: 'Thermal test',
    scheduled_start: new Date(NOW + 60 * 60_000).toISOString(),
    status: 1,
    user_count: 6,
    user_rsvp: false,
    channel_id: 'v1',
    creator_id: '2',
  };

  it('takes a scheduled event in the future', () => {
    expect(toLobbyEvent(base, NOW)?.name).toBe('Thermal test');
  });

  it('keeps an event that is already running', () => {
    expect(
      toLobbyEvent({ ...base, status: 2, scheduled_start: new Date(NOW - 60_000).toISOString() }, NOW),
    ).not.toBeNull();
  });

  it('refuses one that is cancelled, completed, past, or unparseable', () => {
    expect(toLobbyEvent({ ...base, status: 4 }, NOW)).toBeNull();
    expect(toLobbyEvent({ ...base, status: 3 }, NOW)).toBeNull();
    expect(toLobbyEvent({ ...base, scheduled_start: new Date(NOW - 60_000).toISOString() }, NOW)).toBeNull();
    expect(toLobbyEvent({ ...base, scheduled_start: 'soon' }, NOW)).toBeNull();
    expect(toLobbyEvent({ ...base, name: '   ' }, NOW)).toBeNull();
    expect(toLobbyEvent(null, NOW)).toBeNull();
  });

  it('picks the soonest of several, and nothing at all from an empty calendar', () => {
    const later = { ...base, id: 'e2', scheduled_start: new Date(NOW + 3 * 60 * 60_000).toISOString() };
    expect(nextEventOf([later, base], NOW)?.id).toBe('e1');
    expect(nextEventOf([], NOW)).toBeNull();
    expect(nextEventOf({ message: 'nope' }, NOW)).toBeNull();
  });
});

describe('what the media strip will show', () => {
  const image = (id: string): Attachment =>
    ({ id, filename: `${id}.png`, size: 1, url: `/attachments/${id}`, content_type: 'image/png' }) as Attachment;

  const message = (over: Partial<Message> & { id: string }): Message =>
    ({
      channel_id: 't1',
      author: { id: '1', username: 'mara', display_name: 'Mara' },
      content: '',
      attachments: [],
      pinned: false,
      created_at: new Date(NOW).toISOString(),
      ...over,
    }) as unknown as Message;

  it('takes the newest images from the rooms it was given', () => {
    const media = selectRecentMedia(
      {
        t1: [
          message({ id: '1', attachments: [image('a')], created_at: new Date(NOW - 3_000).toISOString() }),
          message({ id: '2', attachments: [image('b')], created_at: new Date(NOW - 1_000).toISOString() }),
        ],
        t2: [message({ id: '3', attachments: [image('c')] })],
      },
      ['t1'],
      NOW,
      4,
    );
    expect(media.items.map((item) => item.attachment.id)).toEqual(['b', 'a']);
    expect(media.weekCount).toBe(2);
  });

  it('refuses ciphertext, federated files, and things that are not images', () => {
    const media = selectRecentMedia(
      {
        t1: [
          message({ id: '1', attachments: [image('a')], e2ee: { v: 1 } as never }),
          message({ id: '2', attachments: [{ ...image('b'), origin_server: 'other.example' }] }),
          message({
            id: '3',
            attachments: [{ ...image('c'), filename: 'notes.pdf', content_type: 'application/pdf' }],
          }),
        ],
      },
      ['t1'],
      NOW,
      4,
    );
    expect(media.items).toEqual([]);
    expect(media.weekCount).toBe(0);
  });

  it('counts only the last seven days, but still shows what is older', () => {
    const media = selectRecentMedia(
      {
        t1: [
          message({ id: '1', attachments: [image('old')], created_at: new Date(NOW - 30 * 86_400_000).toISOString() }),
        ],
      },
      ['t1'],
      NOW,
      4,
    );
    expect(media.items).toHaveLength(1);
    expect(media.weekCount).toBe(0);
  });

  it('caps the strip at the number of tiles it draws', () => {
    const media = selectRecentMedia(
      { t1: Array.from({ length: 9 }, (_, i) => message({ id: String(i + 1), attachments: [image(`a${i}`)] })) },
      ['t1'],
      NOW,
      4,
    );
    expect(media.items).toHaveLength(4);
    expect(media.weekCount).toBe(9);
  });
});

/* -------------------------------------------------------------------------- */
/* WP0's standing rule                                                         */
/* -------------------------------------------------------------------------- */

describe('no Lobby component hard-codes a colour', () => {
  it('renders every part, in every state, without a literal hex or rgb value', () => {
    const { container } = render(
      <div>
        <LobbyHeader
          guildId="g1"
          name="Kestrel Robotics"
          summary="24 of 61 have their lights on · 2 rooms lit"
          onInvite={() => {}}
          onSettings={() => {}}
        />
        <AroundNowWell
          people={[person('1', 'Mara'), person('5', 'Devon', { status: 'idle' })]}
          sentence="Mara is in Shop floor · Devon is away"
          lightsOn={24}
        />
        <RoomCard room={litRoom({ speaking: true, sharing: true })} onEnter={() => {}} onJoin={() => {}} nowMs={NOW} />
        <RoomCard room={darkRoom()} onJoin={() => {}} nowMs={NOW} />
        <AddRoomTile onClick={() => {}} />
        <EventCard event={EVENT} where="Shop floor" host="Priya" onRsvp={() => {}} nowMs={NOW} />
        <TextRoomRow room={textRoom(true)} active unread mentionCount={2} preview="hi" onOpen={() => {}} />
        <TextRoomRow room={textRoom(false)} onOpen={() => {}} />
      </div>,
    );
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(\s*\d/);
  });
});

describe('the text rooms\' last line', () => {
  const author = { id: '9', username: 'priya', display_name: 'Priya', discriminator: '0' };

  it('names the author and flattens the markdown', () => {
    const preview = toPreview({
      id: '357000000000000000',
      content: 'Pushed the **revised** `bracket` drawings',
      author,
      timestamp: '2026-09-13T15:00:00.000Z',
    } as unknown as Message);
    expect(preview).not.toBeNull();
    expect(preview?.author).toBe('Priya');
    expect(preview?.preview).toBe('Pushed the revised bracket drawings');
    expect(preview?.atMs).toBe(Date.parse('2026-09-13T15:00:00.000Z'));
  });

  it('refuses to preview ciphertext', () => {
    expect(
      toPreview({ id: '1', content: 'AAAA', author, e2ee: true } as unknown as Message),
    ).toBeNull();
  });

  it('has nothing to say about a room with no messages', () => {
    expect(toPreview(undefined)).toBeNull();
  });
});
