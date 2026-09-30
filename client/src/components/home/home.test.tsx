import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { HomeAroundNow } from './HomeAroundNow';
import { HomeComingUp } from './HomeComingUp';
import { HomeLiveNow, liveRoomsOf } from './HomeLiveNow';
import { HomePickUp } from './HomePickUp';
import { mentionCaption } from './homeCaptions';
import { aroundNowPeople } from './homeModel';
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

/* -------------------------------------------------------------------------- */

describe('the words Home adds', () => {
  it('counts mentions the way the rest of the app does', () => {
    expect(mentionCaption(1)).toBe('1 mention for you');
    expect(mentionCaption(3)).toBe('3 mentions for you');
  });
});

describe('what Home picks out of the light models', () => {
  it('orders the Around-now faces speakers first, then lit, then by name', () => {
    const speaking = who('5', 'Zara', { speaking: true, inRoom: true, roomName: 'Shop floor' });
    const room = voice({
      occupants: [{ person: REN }, { person: speaking, speaking: true }, { person: MARA }],
    });
    expect(
      aroundNowPeople([building([room], { members: [MARA, REN] })]).map((person) => person.name),
    ).toEqual(['Zara', 'Mara', 'Ren']);
  });

  it('carries a face for somebody whose lights are on but who is in no room', () => {
    // Priya is a member with her lights on and is in nothing. Leaving her out
    // is what let the well say "nobody" while the title counted her.
    const room = voice({ occupants: [{ person: MARA }] });
    expect(aroundNowPeople([building([room])]).map((person) => person.name)).toEqual([
      'Mara',
      'Priya',
      'Ren',
    ]);
  });

  it('leaves a member whose lights are off out of the faces', () => {
    const off = who('6', 'Tomas', { status: 'offline' });
    const people = aroundNowPeople([building([voice()], { members: [MARA, off] })]);
    expect(people.map((person) => person.name)).toEqual(['Mara']);
  });

  it('counts one person once even when two rooms can see them', () => {
    const room = voice({ occupants: [{ person: MARA }] });
    const reading = text({ typingUserIds: ['1'] });
    const people = aroundNowPeople([building([room, reading], { members: [MARA] })]);
    expect(people).toHaveLength(1);
  });
});

describe('Live now', () => {
  it('lists only the voice rooms somebody is in, the busiest first', () => {
    const quiet = building([voice({ channelId: 'v0', name: 'Empty room', occupants: [] })], { guildId: 'g2', name: 'Saltmarsh Sailing' });
    const two = building(
      [
        voice({ channelId: 'v1', name: 'Shop floor', occupants: [{ person: MARA }] }),
        voice({ channelId: 'v2', name: 'Pit lane', occupants: [{ person: PRIYA }, { person: REN }] }),
        text({ channelId: 't1' }),
      ],
    );
    expect(liveRoomsOf([quiet, two]).map(({ room }) => room.name)).toEqual(['Pit lane', 'Shop floor']);
  });

  it('names the server, the people and what they are doing, and puts Join in cream on the first', async () => {
    const on = { onOpenRoom: vi.fn(), onJoinRoom: vi.fn() };
    const lit = litBuilding();
    render(<HomeLiveNow rooms={liveRoomsOf([lit])} nowMs={NOW} {...on} />);
    const section = screen.getByRole('region', { name: 'Live now' });
    const row = within(section).getByRole('listitem', { name: 'Shop floor, live' });
    expect(row).toHaveTextContent('Kestrel Robotics');
    expect(within(row).getByText('Mara is streaming')).toBeInTheDocument();
    expect(within(row).getByText(/In the room: Mara, Priya, Ren/)).toBeInTheDocument();
    const join = within(row).getByRole('button', { name: 'Join Shop floor' });
    expect(join).toHaveClass('glass-btn--primary');
    await userEvent.click(join);
    expect(on.onJoinRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Kestrel Robotics' }),
      expect.objectContaining({ name: 'Shop floor' }),
    );
    await userEvent.click(within(row).getByRole('button', { name: 'Open Shop floor' }));
    expect(on.onOpenRoom).toHaveBeenCalled();
  });

  it('writes how long a stream has run only when the wire says when it began', () => {
    const lit = litBuilding();
    const { rerender } = render(<HomeLiveNow rooms={liveRoomsOf([lit])} nowMs={NOW} onOpenRoom={vi.fn()} onJoinRoom={vi.fn()} />);
    // No start time on the wire: this client's own observation is never presented as the stream's age.
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    rerender(<HomeLiveNow rooms={liveRoomsOf([lit])} nowMs={NOW} onOpenRoom={vi.fn()} onJoinRoom={vi.fn()} />);
    expect(screen.queryByText(/LIVE \d+ MIN/)).not.toBeInTheDocument();
  });

  it('is absent when nobody is in a call', () => {
    const { container } = render(<HomeLiveNow rooms={[]} nowMs={NOW} onOpenRoom={vi.fn()} onJoinRoom={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says Return, not Join, for a call you are already in', () => {
    const inCall = building([{ ...voice({ occupants: [{ person: MARA }] }), youAreHere: true }]);
    render(<HomeLiveNow rooms={liveRoomsOf([inCall])} nowMs={NOW} onOpenRoom={vi.fn()} onJoinRoom={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Return Shop floor' })).toBeInTheDocument();
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
    expect(screen.getByText('+27 online')).toBeInTheDocument();
  });

  it('drops the overflow count when every lit person is already on screen', () => {
    render(<HomeAroundNow people={[MARA, DEVON]} sentence="Devon is away" lightsOn={1} />);
    expect(screen.queryByText(/online/)).not.toBeInTheDocument();
  });

  it('puts people in a call first, and rings only them in amber', () => {
    const { container } = render(
      <HomeAroundNow
        people={[MARA, PRIYA, REN]}
        sentence=""
        lightsOn={3}
        inCall={new Set(['3'])}
      />,
    );
    const faces = [...container.querySelectorAll('.glass-around__face')];
    expect(faces).toHaveLength(3);
    expect(faces[0]).toHaveAttribute('data-live');
    expect(container.querySelectorAll('[data-live]')).toHaveLength(1);
    // No sentence means no empty paragraph.
    expect(container.querySelector('.glass-around__line')).toBeNull();
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
    startsAtMs: new Date(2026, 8, 12, 21, 30, 0, 0).getTime(),
    roomName: 'Shop floor',
    location: null,
    going: 6,
    rsvp: false,
  };

  it('is a plan card that says when, where, who and how many', () => {
    render(<HomeComingUp events={[event]} nowMs={NOW} onSetGoing={vi.fn()} />);
    const card = screen.getByRole('group', { name: 'Event: Thermal test — driver v3' });
    expect(card).toHaveTextContent('Tonight at 9:30 PM in Shop floor · Kestrel Robotics · 6 going');
  });

  it('offers exactly one decision, and reflects the answer you already gave', async () => {
    const onSetGoing = vi.fn();
    const { rerender } = render(
      <HomeComingUp events={[event]} nowMs={NOW} onSetGoing={onSetGoing} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Take the spot' }));
    expect(onSetGoing).toHaveBeenCalledWith(event, true);
    rerender(
      <HomeComingUp events={[{ ...event, rsvp: true }]} nowMs={NOW} onSetGoing={onSetGoing} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'You’re in' }));
    expect(onSetGoing).toHaveBeenLastCalledWith({ ...event, rsvp: true }, false);
  });

  it('is absent entirely when nothing is scheduled', () => {
    const { container } = render(<HomeComingUp events={[]} nowMs={NOW} onSetGoing={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Pick up the conversation', () => {
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

  it('is absent when there is nothing to return to', () => {
    const { container } = render(
      <HomePickUp entries={[]} litRooms={new Set()} onOpen={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('marks a person amber only when a call is live in that conversation', () => {
    const row = entry({ kind: 'dm', title: 'Ada', userId: 'ada', contextLabel: null });
    const { container, rerender } = render(
      <HomePickUp entries={[row]} litRooms={new Set()} onOpen={vi.fn()} />,
    );
    expect(container.querySelector('.glass-presence[data-live]')).toBeNull();
    rerender(<HomePickUp entries={[row]} litRooms={new Set([row.key])} onOpen={vi.fn()} />);
    expect(container.querySelector('.glass-presence[data-live]')).not.toBeNull();
  });

  it('opens the row it was asked to open', async () => {
    const onOpen = vi.fn();
    const row = entry();
    render(<HomePickUp entries={[row]} litRooms={new Set()} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open regatta-2026' }));
    expect(onOpen).toHaveBeenCalledWith(row);
  });
});

/* The rule WP0 set and WP1 kept: a surface styles itself from tokens, never
   from a literal value, or a theme cannot remap it (§1.7). */
describe('tokens only', () => {
  it('renders the whole Home surface without a literal hex or rgb value', () => {
    const { container } = render(
      <div>
        <HomeAroundNow people={[MARA, DEVON]} sentence="Mara is in Shop floor" lightsOn={9} />
        <HomeLiveNow rooms={liveRoomsOf([litBuilding()])} nowMs={NOW} onOpenRoom={vi.fn()} onJoinRoom={vi.fn()} />
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
