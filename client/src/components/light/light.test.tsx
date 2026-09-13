import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  AvatarStack,
  BuildingPlate,
  HereNowStrip,
  LightCaption,
  LitAvatar,
  LiveDot,
  OnAirPill,
  RoomThumbnail,
  WindowMap,
  avatarInitials,
  roomCaptionFor,
} from './index';
import {
  buildingLight,
  personLight,
  textRoomLight,
  voiceRoomLight,
  type BuildingLight,
  type PersonLight,
  type RoomLight,
} from '../../lib/attention/light';

const SCOPE = { serverId: 'a', userId: 'viewer' };
const NOW = 1_800_000_000_000;

function who(userId: string, name: string, over: Partial<Parameters<typeof personLight>[0]> = {}) {
  return personLight({ userId, name, status: 'online', ...over });
}
const MARA = who('1', 'Mara');
const PRIYA = who('2', 'Priya');
const REN = who('3', 'Ren');
const DEVON = who('6', 'Devon', { status: 'idle' });
const DND = who('7', 'Sasha', { status: 'dnd' });

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
    candidates: [MARA, PRIYA],
    nowMs: NOW,
    ...over,
  });
}

function building(rooms: RoomLight[], members: PersonLight[] = [MARA, PRIYA, REN]): BuildingLight {
  return buildingLight({
    scope: SCOPE,
    guildId: 'g1',
    name: 'Kestrel Robotics',
    rooms,
    members,
    memberCount: 61,
  });
}

/* -------------------------------------------------------------------------- */

describe('LitAvatar', () => {
  it('carries the rim when their lights are on', () => {
    const { container } = render(<LitAvatar person={MARA} />);
    expect(container.querySelector('.pc-lit')).not.toBeNull();
  });

  it('breathes for a speaker and is matte when they are away', () => {
    const speaker = who('1', 'Mara', { speaking: true, inRoom: true, roomName: 'Shop floor' });
    expect(render(<LitAvatar person={speaker} />).container.querySelector('.pc-speaking')).not.toBeNull();
    expect(render(<LitAvatar person={DEVON} />).container.querySelector('.pc-dim')).not.toBeNull();
  });

  it('marks do-not-disturb with the slash, not a colour dot', () => {
    const { container } = render(<LitAvatar person={DND} />);
    expect(container.querySelector('.pc-dnd')).not.toBeNull();
  });

  it('always renders the text equivalent of the light', () => {
    render(<LitAvatar person={DEVON} />);
    expect(screen.getByText('Devon — Away')).toBeTruthy();
  });

  it('falls back to initials, never to an emerald chip', () => {
    expect(avatarInitials('Mara Okafor')).toBe('MO');
    expect(avatarInitials('sam.douglas')).toBe('SD');
    expect(avatarInitials('')).toBe('?');
    const { container } = render(<LitAvatar person={MARA} />);
    expect(container.textContent).toContain('M');
  });
});

describe('AvatarStack', () => {
  it('overlaps the faces and counts the rest', () => {
    render(<AvatarStack people={[MARA, PRIYA, REN, DEVON]} max={2} context="in Shop floor" />);
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('Mara, Priya and 2 others in Shop floor')).toBeTruthy();
  });

  it('names nobody when nobody is there', () => {
    const { container } = render(<AvatarStack people={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('WindowMap', () => {
  it('draws one cell per room in the three states', () => {
    const rooms = [
      voice({ occupants: [{ person: MARA }] }),
      voice({ channelId: 'v2', name: 'Lounge', order: 1 }),
      text({ typingUserIds: ['1'], order: 2 }),
    ];
    const { container } = render(
      <WindowMap windows={building(rooms).windows} caption="1 room lit · 1 reading" />,
    );
    expect(container.querySelectorAll('.pc-window')).toHaveLength(3);
    expect(container.querySelectorAll('.pc-window.is-talking')).toHaveLength(1);
    expect(container.querySelectorAll('.pc-window.is-reading')).toHaveLength(1);
    expect(screen.getByText('1 room lit · 1 reading')).toBeTruthy();
  });

  it('never draws more than eight per row', () => {
    const { container } = render(<WindowMap windows={building([]).windows} columns={20} />);
    const grid = container.querySelector('[style*="grid-template-columns"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(8, 10px)');
  });

  it('uses the larger cell on Home', () => {
    const rooms = [voice({ occupants: [{ person: MARA }] })];
    const { container } = render(<WindowMap windows={building(rooms).windows} scale="home" />);
    expect(container.querySelector('.pc-window')).toHaveClass('is-large');
  });

  it('says in words how many rooms are lit, and how many did not fit', () => {
    const rooms = Array.from({ length: 20 }, (_, index) =>
      voice({ channelId: `v${index}`, name: `room-${index}`, order: index }),
    );
    const built = building(rooms);
    render(<WindowMap windows={built.windows} overflowCount={built.overflowCount} />);
    expect(screen.getByText(/0 of 20 rooms lit, 4 more not shown/)).toBeTruthy();
  });
});

describe('BuildingPlate', () => {
  it('lights the plate and lamps it only when a room inside is lit', () => {
    const lit = render(
      <BuildingPlate building={building([voice({ occupants: [{ person: MARA }] })])} />,
    );
    expect(lit.container.querySelector('.pc-plate.is-lit')).not.toBeNull();
    expect(lit.container.querySelector('.pc-lamp')).not.toBeNull();

    const dark = render(<BuildingPlate building={building([voice()])} />);
    expect(dark.container.querySelector('.is-lit')).toBeNull();
    expect(dark.container.querySelector('.pc-lamp')).toBeNull();
  });

  it('renders exactly one lamp — the only permitted radial', () => {
    const { container } = render(
      <BuildingPlate building={building([voice({ occupants: [{ person: MARA }] }), text({ typingUserIds: ['2'] })])} />,
    );
    expect(container.querySelectorAll('.pc-lamp')).toHaveLength(1);
  });

  it('shows the building caption', () => {
    render(<BuildingPlate building={building([voice({ occupants: [{ person: MARA }] })])} />);
    expect(screen.getAllByText('1 room lit').length).toBeGreaterThan(0);
  });
});

describe('RoomThumbnail', () => {
  it('says the room is dark rather than drawing a black rectangle', () => {
    render(<RoomThumbnail room={voice()} />);
    expect(screen.getByText('Dark · nobody in')).toBeTruthy();
  });

  it('shows the LIVE dot and the label for a lit room it cannot sample', () => {
    const room = voice({ occupants: [{ person: MARA, sharingScreen: true }] });
    const { container } = render(<RoomThumbnail room={room} height={168} />);
    expect(room.thumbnail.live).toBe(false);
    expect(container.querySelector('.pc-live-dot')).not.toBeNull();
    expect(screen.getByText('LIVE · Mara is sharing a screen')).toBeTruthy();
  });

  it('paints a sampled frame only when the model says frames are live', () => {
    const room = voice({
      occupants: [{ person: MARA, sharingScreen: true }],
      thumbnail: { live: true, reason: null, label: 'LIVE · sharing' },
    });
    const frame = {
      bitmap: {} as ImageBitmap,
      width: 2,
      height: 2,
      capturedAt: 0,
    };
    const { container } = render(<RoomThumbnail room={room} frame={frame} />);
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('ignores a frame for a room whose model says it is a still', () => {
    const room = voice({ occupants: [{ person: MARA }] });
    const frame = { bitmap: {} as ImageBitmap, width: 2, height: 2, capturedAt: 0 };
    const { container } = render(<RoomThumbnail room={room} frame={frame} />);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('takes the three heights the contract names', () => {
    for (const height of [64, 168, 176] as const) {
      const { container } = render(<RoomThumbnail room={voice()} height={height} />);
      expect((container.firstElementChild as HTMLElement).style.height).toBe(`${height}px`);
    }
  });
});

describe('HereNowStrip', () => {
  const hereNow = {
    people: [MARA, PRIYA],
    here: 2,
    lightsOn: 20,
    caption: '2 here · 20 lights on',
  };

  it('reads as a sentence, not a member list', () => {
    render(<HereNowStrip hereNow={hereNow} context="in Shop floor" />);
    expect(screen.getByText('2 here')).toBeTruthy();
    expect(screen.getByText(/20 lights on/)).toBeTruthy();
  });

  it('opens the people sheet — the only full list in the product', () => {
    render(<HereNowStrip hereNow={hereNow} everyone={[MARA, PRIYA, DEVON]} />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'People here now' })).toBeTruthy();
    expect(screen.getByText('Devon')).toBeTruthy();
    expect(screen.getByText('Away')).toBeTruthy();
  });

  it('invites you to speak rather than saying "No data"', () => {
    render(
      <HereNowStrip hereNow={{ people: [], here: 0, lightsOn: 0, caption: '0 here · 0 lights on' }} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/say something and the room lights up/)).toBeTruthy();
  });
});

describe('OnAirPill', () => {
  const onAir = {
    room: null,
    roomName: 'Shop floor',
    buildingName: 'Kestrel Robotics',
    durationMs: 34 * 60_000 + 12_000,
    micOn: true,
    deafened: false,
    sharing: false,
  };

  it('shows the room, the duration and the mic state', () => {
    render(<OnAirPill onAir={onAir} />);
    expect(screen.getByText('Shop floor')).toBeTruthy();
    expect(screen.getByText('34:12')).toBeTruthy();
    expect(screen.getByText('mic on')).toBeTruthy();
  });

  it('returns you to the Stage', () => {
    const onReturn = vi.fn();
    render(<OnAirPill onAir={onAir} onReturn={onReturn} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('names the whole state for a screen reader', () => {
    render(<OnAirPill onAir={{ ...onAir, micOn: false, sharing: true }} />);
    expect(
      screen.getByText(
        'You are in Shop floor in Kestrel Robotics — mic off, sharing your screen. Return to the room.',
      ),
    ).toBeTruthy();
  });
});

describe('LiveDot and LightCaption', () => {
  it('keeps the LIVE badge quieter than the room', () => {
    const { container } = render(<LiveDot label="LIVE · sharing" />);
    const dot = container.querySelector('.pc-live-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(container.textContent).toBe('LIVE · sharing');
  });

  it('words a room for the surface it is on', () => {
    const dark = voice();
    expect(roomCaptionFor(dark)).toBe('Dark · nobody in');
    expect(roomCaptionFor(dark, { surface: 'card' })).toBe("Dark · nobody's in");
    expect(
      roomCaptionFor({ ...dark, lastLitMs: NOW - 7_200_000 }, {
        surface: 'card',
        withLastLit: true,
        nowMs: NOW,
      }),
    ).toBe("Dark · nobody's in · last lit 2 h ago");
    expect(
      roomCaptionFor(voice({ occupants: [{ person: MARA, speaking: true }] })),
    ).toBe('1 talking');
    expect(roomCaptionFor(text({ typingUserIds: ['1', '2'] }))).toBe('2 reading');
  });

  it('renders captions in the meta ink', () => {
    const { container } = render(<LightCaption mono>34:12</LightCaption>);
    expect(container.firstElementChild).toHaveClass('pc-mono');
  });
});

describe('no light component hard-codes a colour', () => {
  it('renders every component and every state without a literal hex or rgb value', () => {
    const rooms = [
      voice({ occupants: [{ person: MARA, speaking: true, sharingScreen: true }] }),
      voice({ channelId: 'v2', name: 'Lounge', order: 1 }),
      text({ typingUserIds: ['1', '2'], order: 2 }),
    ];
    const built = building(rooms);
    const { container } = render(
      <div>
        <LitAvatar person={MARA} />
        <LitAvatar person={DEVON} />
        <LitAvatar person={DND} />
        <AvatarStack people={[MARA, PRIYA, REN, DEVON]} max={2} />
        <WindowMap windows={built.windows} caption={built.caption} />
        <BuildingPlate building={built} />
        <RoomThumbnail room={rooms[0]} height={168} />
        <RoomThumbnail room={rooms[1]} />
        <HereNowStrip
          hereNow={{ people: [MARA, PRIYA], here: 2, lightsOn: 20, caption: '2 here · 20 lights on' }}
        />
        <OnAirPill
          onAir={{
            room: null,
            roomName: 'Shop floor',
            buildingName: 'Kestrel Robotics',
            durationMs: 1_000,
            micOn: true,
            deafened: false,
            sharing: false,
          }}
        />
        <LiveDot label="LIVE" />
        <LightCaption>3 talking</LightCaption>
      </div>,
    );
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(\s*\d/);
  });
});
