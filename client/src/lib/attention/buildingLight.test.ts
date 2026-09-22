import { describe, expect, it } from 'vitest';

import {
  aroundNowSentence,
  brightnessOf,
  buildingLight,
  orderBuildingsByBrightness,
  orderRoomsForWindows,
  windowsFor,
} from './buildingLight';
import { personLight } from './personLight';
import { textRoomLight, voiceRoomLight } from './roomLight';
import { MAX_WINDOWS, type RoomLight } from './lightModel';

const SCOPE = { serverId: 'a', userId: 'viewer' };
const NOW = 1_800_000_000_000;

function who(userId: string, name: string, status = 'online') {
  return personLight({ userId, name, status });
}
const MARA = who('1', 'Mara');
const PRIYA = who('2', 'Priya');
const REN = who('3', 'Ren');
const TOMAS = who('4', 'Tomas');
const AISHA = who('5', 'Aisha');
const DEVON = who('6', 'Devon', 'idle');

function voice(channelId: string, name: string, people: typeof MARA[], speaking = 0): RoomLight {
  return voiceRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId,
    name,
    occupants: people.map((person, index) => ({ person, speaking: index < speaking })),
    nowMs: NOW,
  });
}

function text(channelId: string, name: string, readers: typeof MARA[]): RoomLight {
  return textRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId,
    name,
    candidates: readers,
    typingUserIds: readers.map((person) => person.userId),
    nowMs: NOW,
  });
}

describe('window map', () => {
  it('draws voice rooms first, then text rooms by activity', () => {
    const rooms = [
      text('t1', 'general', []),
      text('t2', 'build-log', [TOMAS, AISHA]),
      voice('v1', 'Lounge', []),
      voice('v2', 'Shop floor', [MARA, PRIYA, REN]),
    ];
    expect(orderRoomsForWindows(rooms).map((room) => room.name)).toEqual([
      'Shop floor',
      'Lounge',
      'build-log',
      'general',
    ]);
  });

  it('paints one cell per room in the three states', () => {
    const windows = windowsFor([
      voice('v1', 'Shop floor', [MARA]),
      text('t1', 'build-log', [TOMAS]),
      voice('v2', 'Lounge', []),
    ]);
    // Voice first (lit, then dark), then text — so the amber cell is last here.
    expect(windows.map((window) => window.state)).toEqual(['on', 'dark', 'warm']);
    expect(windows[0].label).toBe('Shop floor — 1 in');
  });

  it('never draws a third row — the rest collapses into the count', () => {
    const rooms = Array.from({ length: 21 }, (_, index) =>
      text(`t${index}`, `room-${String(index).padStart(2, '0')}`, []),
    );
    const building = buildingLight({
      scope: SCOPE,
      guildId: 'g1',
      name: 'Kestrel Robotics',
      rooms,
      members: [],
    });
    expect(building.windows).toHaveLength(MAX_WINDOWS);
    expect(building.overflowCount).toBe(21 - MAX_WINDOWS);
  });
});

describe('server light', () => {
  const rooms = [
    voice('v1', 'Shop floor', [MARA, PRIYA, REN], 1),
    voice('v2', 'Lounge', []),
    text('t1', 'build-log', [TOMAS, AISHA]),
    text('t2', 'general', []),
  ];
  const members = [MARA, PRIYA, REN, TOMAS, AISHA, DEVON];

  it('counts what is lit and captions it', () => {
    const building = buildingLight({
      scope: SCOPE,
      guildId: 'g1',
      name: 'Kestrel Robotics',
      rooms,
      members,
      memberCount: 61,
    });
    expect(building.roomsLit).toBe(1);
    expect(building.talkingCount).toBe(1);
    expect(building.readingCount).toBe(2);
    expect(building.lightsOn).toBe(5);
    expect(building.memberCount).toBe(61);
    expect(building.caption).toBe('3 in voice · 2 here');
    expect(building.key).toBe(JSON.stringify(['a', 'viewer', 'g1']));
  });

  it('picks the loudest lit voice room for the server thumbnail', () => {
    const building = buildingLight({
      scope: SCOPE,
      guildId: 'g1',
      name: 'Kestrel',
      rooms: [voice('v2', 'Lounge', [TOMAS]), voice('v1', 'Shop floor', [MARA, PRIYA], 2)],
      members,
    });
    expect(building.brightestRoom?.name).toBe('Shop floor');
  });

  it('has no brightest room when every room is dark', () => {
    const building = buildingLight({
      scope: SCOPE,
      guildId: 'g1',
      name: 'Kestrel',
      rooms: [voice('v1', 'Shop floor', [])],
      members: [],
    });
    expect(building.brightestRoom).toBeNull();
    expect(building.caption).toBe('Nobody in voice');
  });
});

describe('brightest first', () => {
  it('ranks talking over reading over merely lit', () => {
    const talking = brightnessOf({ talkingCount: 1, roomsLit: 1, readingCount: 0, lightsOn: 1 });
    const reading = brightnessOf({ talkingCount: 0, roomsLit: 0, readingCount: 9, lightsOn: 9 });
    const quiet = brightnessOf({ talkingCount: 0, roomsLit: 0, readingCount: 0, lightsOn: 40 });
    expect(talking).toBeGreaterThan(reading);
    expect(reading).toBeGreaterThan(quiet);
  });

  it('orders servers and breaks ties deterministically', () => {
    const make = (name: string, rooms: RoomLight[], members: typeof MARA[]) =>
      buildingLight({ scope: SCOPE, guildId: name, name, rooms, members });
    const ordered = orderBuildingsByBrightness([
      make('Zephyr', [], []),
      make('Kestrel', [voice('v1', 'Shop floor', [MARA, PRIYA], 1)], [MARA, PRIYA]),
      make('Alder', [], []),
      make('Saltmarsh', [text('t1', 'regatta', [REN])], [REN]),
    ]);
    expect(ordered.map((building) => building.name)).toEqual([
      'Kestrel',
      'Saltmarsh',
      'Alder',
      'Zephyr',
    ]);
  });
});

describe('around now', () => {
  it('names who is where in one sentence', () => {
    const sentence = aroundNowSentence({
      rooms: [
        voice('v1', 'Shop floor', [MARA, PRIYA, REN]),
        text('t1', 'build-log', [TOMAS, AISHA]),
      ],
      people: [DEVON],
    });
    expect(sentence).toBe(
      // Names inside a clause are alphabetical, so the sentence is stable
      // between ticks rather than reshuffling with the typing order.
      'Mara, Priya and Ren are in Shop floor · Aisha and Tomas are in #build-log · Devon is away',
    );
  });

  it('uses the singular for one person', () => {
    expect(
      aroundNowSentence({ rooms: [voice('v1', 'Shop floor', [MARA])], people: [] }),
    ).toBe('Mara is in Shop floor');
  });

  it('never says somebody is away while they are in a room', () => {
    const room = voice('v1', 'Shop floor', [MARA]);
    expect(aroundNowSentence({ rooms: [room], people: [MARA, DEVON] })).toBe(
      'Mara is in Shop floor · Devon is away',
    );
  });

  it('caps the clauses — the window map carries the rest', () => {
    const sentence = aroundNowSentence({
      rooms: [
        voice('v1', 'Shop floor', [MARA, PRIYA]),
        voice('v2', 'Lounge', [REN]),
        text('t1', 'build-log', [TOMAS]),
        text('t2', 'general', [AISHA]),
      ],
      people: [DEVON],
      maxClauses: 2,
    });
    expect(sentence.split(' · ')).toHaveLength(2);
  });

  it('says plainly that nobody is online', () => {
    expect(aroundNowSentence({ rooms: [], people: [] })).toBe(
      'Nobody is online right now',
    );
    expect(aroundNowSentence({ rooms: [], people: [], empty: 'Nobody is around' })).toBe(
      'Nobody is around',
    );
  });
});
