import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildingLight,
  personLight,
  textRoomLight,
  voiceRoomLight,
  type BuildingLight,
  type PersonLight,
  type RoomLight,
} from '../../../lib/attention/light';
import { BuildingsColumn, ROOM_ROWS_VISIBLE } from './BuildingsColumn';

/**
 * The Buildings column (docs/lantern-stage-spec.md §7.1).
 *
 * Every case here is a state the contract names — a lit voice room, a dark one,
 * a text room, the open room, the open Lobby, no buildings at all, a building
 * with more rooms than fit, and an account with more buildings than fit. The
 * models come from `lib/attention/light`, never from hand-written props, so a
 * row can only look wrong here if the light itself is wrong.
 */

const SCOPE = { serverId: 'srv', userId: 'viewer' };
const NOW = 1_800_000_000_000;

function who(userId: string, name: string, over: Partial<Parameters<typeof personLight>[0]> = {}): PersonLight {
  return personLight({ userId, name, status: 'online', ...over });
}

const MARA = who('101', 'Mara');
const PRIYA = who('102', 'Priya');
const REN = who('103', 'Ren');

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
    candidates: [],
    nowMs: NOW,
    ...over,
  });
}

function building(rooms: RoomLight[], over: Partial<Parameters<typeof buildingLight>[0]> = {}): BuildingLight {
  return buildingLight({
    scope: SCOPE,
    guildId: 'g1',
    name: 'Kestrel Robotics',
    rooms,
    members: [MARA, PRIYA, REN],
    memberCount: 61,
    ...over,
  });
}

const LIT_VOICE = voice({
  occupants: [
    { person: MARA, speaking: true, sharingScreen: true },
    { person: PRIYA },
    { person: REN },
  ],
  startedAtMs: NOW - 60_000,
});
const DARK_VOICE = voice({ channelId: 'v2', name: 'Lounge', order: 1 });
const READ_TEXT = text({
  candidates: [MARA, PRIYA, REN],
  typingUserIds: ['101', '102', '103'],
  order: 2,
});
const QUIET_TEXT = text({ channelId: 't2', name: 'firmware', order: 3 });

const handlers = {
  onOpenHome: vi.fn(),
  onOpenMessages: vi.fn(),
  onOpenLobby: vi.fn(),
  onOpenRoom: vi.fn(),
  onAddBuilding: vi.fn(),
};

function renderColumn(props: Partial<Parameters<typeof BuildingsColumn>[0]> = {}) {
  return render(
    <BuildingsColumn
      buildings={[building([LIT_VOICE, DARK_VOICE, READ_TEXT, QUIET_TEXT])]}
      needsYouCount={3}
      messagesCount={2}
      {...handlers}
      {...props}
    />,
  );
}

beforeEach(() => {
  for (const handler of Object.values(handlers)) handler.mockClear();
});

describe('BuildingsColumn', () => {
  it('opens with the search well and the Home / Messages rows and their counts', () => {
    renderColumn();

    expect(screen.getByRole('button', { name: /open command palette/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Home/ })).toBeInTheDocument();
    expect(screen.getByLabelText('3 conversations need you')).toHaveTextContent('3');
    expect(screen.getByLabelText('2 unread conversations')).toHaveTextContent('2');

    fireEvent.click(screen.getByRole('option', { name: /^Home/ }));
    expect(handlers.onOpenHome).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: /^Messages/ }));
    expect(handlers.onOpenMessages).toHaveBeenCalled();
  });

  it('omits a count chip that would say nothing', () => {
    renderColumn({ needsYouCount: 0, messagesCount: 0 });
    expect(screen.queryByLabelText(/need you/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/unread/)).not.toBeInTheDocument();
  });

  it('draws a building as its label, its window map plate and its rooms', () => {
    renderColumn();
    const section = screen.getByRole('group', { name: 'Kestrel Robotics' });

    // "Kestrel Robotics · 24 in" — sentence case, the count in the meta ink.
    expect(within(section).getByText('Kestrel Robotics')).toBeInTheDocument();
    expect(within(section).getByText('3 in')).toBeInTheDocument();

    // The plate is the Lobby link and says what the building is doing.
    const plate = within(section).getByRole('option', { name: /lobby/ });
    expect(plate).toHaveAccessibleName(/1 room lit · 3 reading/);
    fireEvent.click(plate);
    expect(handlers.onOpenLobby).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'g1' }));
  });

  it('renders a lit voice room as a live thumbnail row, and a dark one as a plain row', () => {
    renderColumn();
    const section = screen.getByRole('group', { name: 'Kestrel Robotics' });

    const live = within(section).getByRole('option', { name: /Shop floor/ });
    expect(live).toHaveTextContent('Shop floor');
    expect(live).toHaveTextContent('1 talking');
    // §9: the LIVE dot is never the only cue.
    expect(within(live).getByText(/LIVE/)).toBeInTheDocument();

    const dark = within(section).getByRole('option', { name: /Lounge/ });
    expect(dark).toHaveTextContent('Lounge');
    expect(dark).toHaveAccessibleName(/Dark · nobody in/);

    fireEvent.click(dark);
    // The row also hands back the element it was clicked on: §5.1's shared
    // element needs an origin, because a room's name is on its card, its row
    // and the inline "lit up" event at the same time.
    expect(handlers.onOpenRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Lounge' }),
      dark,
    );
  });

  it('renders text rooms with their reading count, and a mention chip when one is waiting', () => {
    renderColumn({
      attention: new Map([[QUIET_TEXT.key, { unread: true, mentionCount: 4 }]]),
    });
    const section = screen.getByRole('group', { name: 'Kestrel Robotics' });

    expect(within(section).getByRole('option', { name: /build-log/ })).toHaveTextContent('3 reading');
    const quiet = within(section).getByRole('option', { name: /firmware/ });
    expect(within(quiet).getByLabelText('4 mentions')).toHaveTextContent('4');
  });

  it('raises the open room and marks the open Lobby', () => {
    const { rerender } = renderColumn({ activeRoomKey: READ_TEXT.key });
    expect(screen.getByRole('option', { name: /build-log/ })).toHaveAttribute('aria-selected', 'true');

    rerender(
      <BuildingsColumn
        buildings={[building([LIT_VOICE, DARK_VOICE, READ_TEXT, QUIET_TEXT])]}
        needsYouCount={0}
        messagesCount={0}
        activeBuildingKey={building([]).key}
        {...handlers}
      />,
    );
    expect(screen.getByRole('option', { name: /lobby/ })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps exactly one Tab stop and numbers every row in one flat order', () => {
    renderColumn({ activeRoomKey: DARK_VOICE.key });
    const rows = screen.getAllByRole('option');
    const stops = rows.filter((row) => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAccessibleName(/Lounge/);
    expect(rows.map((row) => Number(row.getAttribute('data-nav-index')))).toEqual(
      rows.map((_row, index) => index),
    );
  });

  it('hangs the open thread off its room without spending a room slot', () => {
    // A thread is not a room (§7.1). It never competes for the fold, it never
    // pushes its own parent behind "N more rooms", and the one you are in is an
    // indented row under the room that owns it so the column can say where you
    // are.
    const onOpenThread = vi.fn();
    renderColumn({
      activeRoomKey: READ_TEXT.key,
      openThread: { key: 'srv:th1', parentKey: READ_TEXT.key, name: 'Bracket tolerance' },
      onOpenThread,
    });
    const section = screen.getByRole('group', { name: 'Kestrel Robotics' });
    const rows = within(section).getAllByRole('option');
    // Plate, four rooms, and the thread — no expander: the rooms still fit.
    expect(rows).toHaveLength(6);
    const thread = within(section).getByRole('option', {
      name: 'Bracket tolerance — a thread in build-log',
    });
    // Directly under its room, and the Tab stop, because it is where you are.
    expect(rows.indexOf(thread)).toBe(rows.findIndex((row) => row.getAttribute('aria-selected') === 'true' && row !== thread) + 1);
    expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toEqual([thread]);
    // The flat arrow order still has no gaps.
    expect(rows.map((row) => Number(row.getAttribute('data-nav-index')))).toEqual([2, 3, 4, 5, 6, 7]);

    fireEvent.click(thread);
    expect(onOpenThread).toHaveBeenCalledTimes(1);
  });

  it('asks for the first building in the metaphor when there are none', () => {
    renderColumn({ buildings: [] });
    expect(
      screen.getByText('Add a building — join with an invite, or start your own.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add a building' }));
    expect(handlers.onAddBuilding).toHaveBeenCalled();
  });

  it('folds a building past eight rooms behind one row, and unfolds it on request', () => {
    const many = Array.from({ length: 14 }, (_room, index) =>
      text({ channelId: `t${index}`, name: `room-${index}`, order: index }),
    );
    renderColumn({ buildings: [building(many)] });
    const section = screen.getByRole('group', { name: 'Kestrel Robotics' });

    // The plate, ROOM_ROWS_VISIBLE rooms and the expander.
    expect(within(section).getAllByRole('option')).toHaveLength(ROOM_ROWS_VISIBLE + 2);
    const expander = within(section).getByRole('option', { name: '6 more rooms' });

    fireEvent.click(expander);
    expect(within(section).getAllByRole('option')).toHaveLength(16);
    fireEvent.click(within(section).getByRole('option', { name: 'Fewer rooms' }));
    expect(within(section).getAllByRole('option')).toHaveLength(ROOM_ROWS_VISIBLE + 2);
  });

  it('keeps a room with unread mentions above the fold', () => {
    const many = Array.from({ length: 14 }, (_room, index) =>
      text({ channelId: `t${index}`, name: `room-${index}`, order: index }),
    );
    // room-12 would sit behind "N more rooms" on light alone.
    const buried = many[12];
    renderColumn({
      buildings: [building(many)],
      attention: new Map([[buried.key, { unread: true, mentionCount: 3 }]]),
    });
    const section = screen.getByRole('group', { name: 'Kestrel Robotics' });
    expect(within(section).getAllByRole('option')).toHaveLength(ROOM_ROWS_VISIBLE + 2);
    expect(within(section).getByRole('option', { name: /room-12/ })).toBeInTheDocument();
    // The fold still accounts for every room it hid.
    expect(within(section).getByRole('option', { name: '6 more rooms' })).toBeInTheDocument();
  });

  it('leaves the light order alone when nothing behind the fold needs you', () => {
    const many = Array.from({ length: 14 }, (_room, index) =>
      text({ channelId: `t${index}`, name: `room-${index}`, order: index }),
    );
    renderColumn({
      buildings: [building(many)],
      attention: new Map([[many[1].key, { unread: true, mentionCount: 0 }]]),
    });
    const section = screen.getByRole('group', { name: 'Kestrel Robotics' });
    expect(within(section).queryByRole('option', { name: /room-12/ })).toBeNull();
    expect(within(section).getByRole('option', { name: /room-7/ })).toBeInTheDocument();
  });

  it('turns into an accordion past the building threshold, keeping lit and open buildings open', () => {
    const dark = Array.from({ length: 10 }, (_building, index) =>
      building([text({ channelId: `d${index}`, name: `notes-${index}` })], {
        guildId: `g${index + 2}`,
        name: `Building ${index}`,
        members: [],
      }),
    );
    const lit = building([LIT_VOICE, DARK_VOICE]);
    renderColumn({ buildings: [lit, ...dark] });

    // A lit building keeps its rooms; a dark one shows its window map and waits.
    expect(
      within(screen.getByRole('group', { name: 'Kestrel Robotics' })).getAllByRole('option'),
    ).toHaveLength(3);
    const folded = screen.getByRole('group', { name: 'Building 0' });
    expect(within(folded).getAllByRole('option')).toHaveLength(2);
    fireEvent.click(within(folded).getByRole('option', { name: '1 more room' }));
    expect(within(folded).getAllByRole('option')).toHaveLength(3);
  });

  it('keeps the open building unfolded even in the accordion', () => {
    const dark = Array.from({ length: 10 }, (_building, index) =>
      building([text({ channelId: `d${index}`, name: `notes-${index}` })], {
        guildId: `g${index + 2}`,
        name: `Building ${index}`,
        members: [],
      }),
    );
    renderColumn({ buildings: dark, activeBuildingKey: dark[3].key });
    expect(within(screen.getByRole('group', { name: 'Building 3' })).getAllByRole('option')).toHaveLength(2);
    expect(within(screen.getByRole('group', { name: 'Building 4' })).getAllByRole('option')).toHaveLength(2);
    // Building 3 spends its second row on the room; Building 4 on the expander.
    expect(
      within(screen.getByRole('group', { name: 'Building 3' })).getByRole('option', { name: /notes-3/ }),
    ).toBeInTheDocument();
  });

  it('never wraps a long name — it truncates', () => {
    const long = building([
      text({ channelId: 't9', name: 'a-very-long-room-name-that-will-not-fit-in-276-pixels' }),
    ], { name: 'A building with an unreasonably long name that must not wrap' });
    renderColumn({ buildings: [long] });
    const row = screen.getByRole('option', { name: /a-very-long-room-name/ });
    expect(row.querySelector('.truncate')).not.toBeNull();
    expect(
      screen.getByText('A building with an unreasonably long name that must not wrap'),
    ).toHaveClass('truncate');
  });

  it('spends no literal colour — tokens only', () => {
    const { container } = renderColumn({
      attention: new Map([[QUIET_TEXT.key, { unread: true, mentionCount: 2 }]]),
    });
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(\s*\d/);
  });
});
