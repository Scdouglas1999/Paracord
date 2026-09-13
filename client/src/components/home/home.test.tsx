import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { HomeAddBuilding } from './HomeAddBuilding';
import { HomeAroundNow } from './HomeAroundNow';
import { HomeBuildingCard } from './HomeBuildingCard';
import { HomeComingUp, eventMeta, eventWhen } from './HomeComingUp';
import { HomePickUp, pickUpContext } from './HomePickUp';
import { buildingMetaCaption, roomActivityLine, textRoomCaption } from './homeCaptions';
import { activeTextRoom, aroundNowPeople, isLitBuilding, litTextRooms } from './homeModel';
import type { ComingUpEvent } from './useComingUp';
import {
  buildingLight,
  personLight,
  textRoomLight,
  voiceRoomLight,
  type BuildingLight,
  type PersonLight,
  type RoomLight,
} from '../../lib/attention/light';
import type { ConversationEntry } from '../../lib/attention/conversationModel';

const SCOPE = { serverId: 'a', userId: 'viewer' };
const NOW = new Date(2026, 8, 12, 20, 0, 0, 0).getTime();

function who(userId: string, name: string, over: Partial<Parameters<typeof personLight>[0]> = {}) {
  return personLight({ userId, name, status: 'online', ...over });
}
const MARA = who('1', 'Mara');
const PRIYA = who('2', 'Priya');
const REN = who('3', 'Ren');
const DEVON = who('4', 'Devon', { status: 'idle' });

function voice(over: Partial<Parameters<typeof voiceRoomLight>[0]> = {}): RoomLight {
  return voiceRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId: 'v1',
    name: 'Shop floor',
    occupants: [],
    nowMs: NOW,
    ...over,
  });
}

function text(over: Partial<Parameters<typeof textRoomLight>[0]> = {}): RoomLight {
  return textRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId: 't1',
    name: 'build-log',
    candidates: [MARA, PRIYA, REN],
    nowMs: NOW,
    ...over,
  });
}

function building(
  rooms: RoomLight[],
  over: { name?: string; guildId?: string; members?: PersonLight[]; memberCount?: number } = {},
): BuildingLight {
  return buildingLight({
    scope: SCOPE,
    guildId: over.guildId ?? 'g1',
    name: over.name ?? 'Kestrel Robotics',
    rooms,
    members: over.members ?? [MARA, PRIYA, REN],
    memberCount: over.memberCount ?? 61,
  });
}

/** A lit building: Mara is sharing a screen in Shop floor, two people reading. */
function litBuilding(): BuildingLight {
  const room = voice({
    occupants: [
      { person: MARA, sharingScreen: true },
      { person: PRIYA },
      { person: REN },
    ],
  });
  const reading = text({ typingUserIds: ['2', '3'] });
  return building([room, reading]);
}

/** A quiet building: nobody talking, one person reading. */
function quietBuilding(): BuildingLight {
  return building([voice({ occupants: [] }), text({ typingUserIds: ['3'] })], {
    name: 'Saltmarsh Sailing',
    guildId: 'g2',
    members: [REN],
    memberCount: 20,
  });
}

const handlers = () => ({
  onOpenBuilding: vi.fn(),
  onOpenRoom: vi.fn(),
  onJoinRoom: vi.fn(),
});

/* -------------------------------------------------------------------------- */

describe('the words Home adds', () => {
  it('names who is doing the loudest thing in a lit room', () => {
    expect(roomActivityLine(voice({ occupants: [{ person: MARA, sharingScreen: true }] }))).toBe(
      'Mara is sharing a screen',
    );
    expect(roomActivityLine(voice({ occupants: [{ person: MARA, sharingCamera: true }] }))).toBe(
      'Mara has their camera on',
    );
    expect(
      roomActivityLine(voice({ occupants: [{ person: MARA, speaking: true }, { person: PRIYA }] })),
    ).toBe('Mara is talking');
    expect(roomActivityLine(voice({ occupants: [{ person: MARA }, { person: PRIYA }] }))).toBe(
      'Mara and Priya are in here',
    );
    expect(roomActivityLine(voice({ occupants: [] }))).toBe("Dark · nobody's in");
  });

  it('never contradicts itself about a building with people but no lit room', () => {
    expect(buildingMetaCaption(litBuilding())).toMatch(/^3 in · 1 room lit/);
    expect(buildingMetaCaption({ lightsOn: 6, roomsLit: 0, readingCount: 0, caption: 'x' })).toBe(
      '6 in · quiet',
    );
    expect(
      buildingMetaCaption({ lightsOn: 0, roomsLit: 0, readingCount: 0, caption: 'Dark · nobody in' }),
    ).toBe('Dark · nobody in');
  });

  it('adds the mentions that are for you to a text room line', () => {
    const reading = text({ typingUserIds: ['2', '3'] });
    expect(textRoomCaption(reading, 0)).toBe('2 reading');
    expect(textRoomCaption(reading, 1)).toBe('2 reading · 1 mention for you');
    expect(textRoomCaption(reading, 3)).toBe('2 reading · 3 mentions for you');
  });
});

describe('what Home picks out of the light models', () => {
  it('orders the Around-now faces speakers first, then lit, then by name', () => {
    const speaking = who('5', 'Zara', { speaking: true, inRoom: true, roomName: 'Shop floor' });
    const room = voice({
      occupants: [{ person: REN }, { person: speaking, speaking: true }, { person: MARA }],
    });
    expect(aroundNowPeople([building([room])]).map((person) => person.name)).toEqual([
      'Zara',
      'Mara',
      'Ren',
    ]);
  });

  it('counts one person once even when two rooms can see them', () => {
    const room = voice({ occupants: [{ person: MARA }] });
    const reading = text({ typingUserIds: ['1'] });
    expect(aroundNowPeople([building([room, reading])])).toHaveLength(1);
  });

  it('treats only a lit voice room as a lit building', () => {
    expect(isLitBuilding(litBuilding())).toBe(true);
    expect(isLitBuilding(quietBuilding())).toBe(false);
    expect(litTextRooms(litBuilding()).map((room) => room.name)).toEqual(['build-log']);
    expect(activeTextRoom(quietBuilding())?.name).toBe('build-log');
    expect(activeTextRoom(building([voice({ occupants: [] }), text()]))).toBeNull();
  });
});

describe('a lit building card', () => {
  it('shows the room, who is in it, what they are doing, and Join in white light', async () => {
    const on = handlers();
    render(<HomeBuildingCard building={litBuilding()} mentions={new Map()} {...on} />);
    const card = screen.getByRole('article', { name: 'Kestrel Robotics' });
    expect(within(card).getByText(/LIVE/)).toBeInTheDocument();
    expect(within(card).getByText('Mara is sharing a screen')).toBeInTheDocument();
    expect(within(card).getByText(/^3 in · 1 room lit/)).toBeInTheDocument();
    const join = within(card).getByRole('button', { name: 'Join' });
    expect(join.className).toContain('bg-light-white');
    await userEvent.click(join);
    expect(on.onJoinRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Kestrel Robotics' }),
      expect.objectContaining({ name: 'Shop floor' }),
    );
  });

  it('lists its lit text rooms with the mentions waiting for you, and opens one', async () => {
    const on = handlers();
    const lit = litBuilding();
    const reading = lit.rooms.find((room) => room.kind === 'text')!;
    render(
      <HomeBuildingCard building={lit} mentions={new Map([[reading.key, 1]])} {...on} />,
    );
    expect(screen.getByText('2 reading · 1 mention for you')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /build-log/ }));
    expect(on.onOpenRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Kestrel Robotics' }),
      expect.objectContaining({ name: 'build-log' }),
    );
  });

  it('draws exactly one window per room and says so for a screen reader', () => {
    const { container } = render(
      <HomeBuildingCard building={litBuilding()} mentions={new Map()} {...handlers()} />,
    );
    // Two rooms in the map, plus the 8px dot on the text-room line.
    expect(container.querySelectorAll('.pc-window.is-large')).toHaveLength(2);
    expect(screen.getByText(/2 of 2 rooms lit/)).toBeInTheDocument();
  });

});

describe('a quiet building row', () => {
  it('is a compact row with its counts, its windows and its one active text room', () => {
    const handle = handlers();
    render(<HomeBuildingCard building={quietBuilding()} mentions={new Map()} {...handle} />);
    const row = screen.getByRole('group', { name: 'Saltmarsh Sailing' });
    expect(within(row).getByText('1 in · 1 reading')).toBeInTheDocument();
    expect(within(row).getByText('build-log')).toBeInTheDocument();
    expect(within(row).queryByText(/LIVE/)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
  });

  it('opens the building from its name', async () => {
    const handle = handlers();
    render(<HomeBuildingCard building={quietBuilding()} mentions={new Map()} {...handle} />);
    await userEvent.click(screen.getByRole('button', { name: 'Saltmarsh Sailing' }));
    expect(handle.onOpenBuilding).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Saltmarsh Sailing' }),
    );
  });

  it('says nothing about a text room when nobody is in one', () => {
    const dark = building([voice({ occupants: [] }), text({ candidates: [] })], {
      name: 'Empty Hall',
      members: [],
      memberCount: 12,
    });
    render(<HomeBuildingCard building={dark} mentions={new Map()} {...handlers()} />);
    const row = screen.getByRole('group', { name: 'Empty Hall' });
    expect(within(row).getByText('Dark · nobody in')).toBeInTheDocument();
    expect(within(row).queryByText('build-log')).not.toBeInTheDocument();
  });
});

describe('Around now', () => {
  it('shows the faces, WP1s sentence, and only the lights it has not drawn', () => {
    render(
      <HomeAroundNow
        people={[MARA, PRIYA, REN]}
        sentence="Mara, Priya and Ren are in Shop floor"
        lightsOn={30}
      />,
    );
    expect(screen.getByText('Mara, Priya and Ren are in Shop floor')).toBeInTheDocument();
    expect(screen.getByText('+27 lights on')).toBeInTheDocument();
  });

  it('drops the overflow count when every lit person is already on screen', () => {
    render(<HomeAroundNow people={[MARA, DEVON]} sentence="Devon is away" lightsOn={1} />);
    expect(screen.queryByText(/lights on/)).not.toBeInTheDocument();
  });
});

describe('Coming up', () => {
  const event: ComingUpEvent = {
    key: 'k',
    buildingKey: 'b',
    scope: SCOPE,
    guildId: 'g1',
    buildingName: 'Kestrel Robotics',
    id: 'e1',
    name: 'Thermal test — driver v3',
    startsAtMs: new Date(2026, 8, 12, 13, 0, 0, 0).getTime(),
    roomName: 'Shop floor',
    location: null,
    going: 6,
    rsvp: false,
  };

  it('says when, where and how many, in one line', () => {
    expect(eventWhen(event.startsAtMs, NOW)).toBe('Today 1:00 pm');
    expect(eventWhen(new Date(2026, 8, 13, 9, 30).getTime(), NOW)).toBe('Tomorrow 9:30 am');
    expect(eventWhen(new Date(2026, 8, 20, 9, 30).getTime(), NOW)).toBe('Sun 20 Sep 9:30 am');
    expect(eventMeta(event, NOW)).toBe(
      'Today 1:00 pm · Kestrel Robotics · Shop floor · 6 going',
    );
  });

  it('offers exactly one action, and reflects the answer you already gave', async () => {
    const onSetGoing = vi.fn();
    const { rerender } = render(
      <HomeComingUp events={[event]} nowMs={NOW} onSetGoing={onSetGoing} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Say you are going/ }));
    expect(onSetGoing).toHaveBeenCalledWith(event, true);
    rerender(
      <HomeComingUp events={[{ ...event, rsvp: true }]} nowMs={NOW} onSetGoing={onSetGoing} />,
    );
    expect(screen.getByText("You're going")).toBeInTheDocument();
  });

  it('is absent entirely when nothing is scheduled', () => {
    const { container } = render(<HomeComingUp events={[]} nowMs={NOW} onSetGoing={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Pick up where you left off', () => {
  function entry(over: Partial<ConversationEntry> = {}): ConversationEntry {
    return {
      scope: SCOPE,
      serverId: 'a',
      key: JSON.stringify(['a', 'viewer', over.channelId ?? 't1']),
      channelId: over.channelId ?? 't1',
      guildId: 'g1',
      kind: 'guild_text',
      title: 'regatta-2026',
      contextLabel: 'Saltmarsh Sailing',
      lastActivityId: '100',
      unread: false,
      mentionCount: 0,
      isDMUnread: false,
      isThreadReply: false,
      hasVoiceActivity: false,
      pinned: false,
      ...over,
    };
  }

  it('says where you were and when it last moved', () => {
    const now = Date.now();
    expect(pickUpContext({ ...entry(), lastActivityId: null }, now)).toBe(
      'Saltmarsh Sailing · nothing new since you left',
    );
    expect(pickUpContext(entry({ kind: 'dm', contextLabel: null }), now)).toMatch(
      /^direct · last message \d+d ago$/,
    );
  });

  it('is absent when there is nothing to return to', () => {
    const { container } = render(
      <HomePickUp entries={[]} litRooms={new Set()} onOpen={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lights a row only when the building says that room is lit', () => {
    const row = entry();
    const { container, rerender } = render(
      <HomePickUp entries={[row]} litRooms={new Set()} onOpen={vi.fn()} />,
    );
    expect(container.querySelector('.pc-window.is-reading')).toBeNull();
    rerender(<HomePickUp entries={[row]} litRooms={new Set([row.key])} onOpen={vi.fn()} />);
    expect(container.querySelector('.pc-window.is-reading')).not.toBeNull();
  });

  it('opens the row it was asked to open', async () => {
    const onOpen = vi.fn();
    const row = entry();
    render(<HomePickUp entries={[row]} litRooms={new Set()} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: /regatta-2026/ }));
    expect(onOpen).toHaveBeenCalledWith(row);
  });
});

describe('Add a building', () => {
  it('is one row that says both ways in', async () => {
    const onClick = vi.fn();
    render(<HomeAddBuilding onClick={onClick} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Add a building — join with an invite, or start your own' }),
    );
    expect(onClick).toHaveBeenCalled();
  });
});

/* The rule WP0 set and WP1 kept: a surface styles itself from tokens, never
   from a literal value, or a theme cannot remap it (§1.7). */
describe('tokens only', () => {
  it('renders the whole Home surface without a literal hex or rgb value', () => {
    const { container } = render(
      <div>
        <HomeAroundNow people={[MARA, DEVON]} sentence="Mara is in Shop floor" lightsOn={9} />
        <HomeBuildingCard building={litBuilding()} mentions={new Map()} {...handlers()} />
        <HomeBuildingCard building={quietBuilding()} mentions={new Map()} {...handlers()} />
        <HomeAddBuilding onClick={vi.fn()} />
      </div>,
    );
    const offenders: string[] = [];
    for (const element of container.querySelectorAll<HTMLElement>('*')) {
      const style = element.getAttribute('style') ?? '';
      const className = element.getAttribute('class') ?? '';
      for (const value of [style, className]) {
        if (/#[0-9a-f]{3,8}\b/i.test(value) || /\brgba?\(/i.test(value)) {
          offenders.push(`${element.tagName}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
