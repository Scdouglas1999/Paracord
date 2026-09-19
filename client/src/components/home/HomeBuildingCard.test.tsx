import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildingLight, personLight, voiceRoomLight } from '../../lib/attention/light';
import type { RoomThumbnailFeed } from '../../hooks/useRoomThumbnail';
import { HomeBuildingCard } from './HomeBuildingCard';

const mockFeed = vi.hoisted(() => ({ frame: null, state: { live: false, reason: 'no-publisher', label: 'LIVE' } })) as RoomThumbnailFeed;
vi.mock('../../hooks/useRoomThumbnail', () => ({ useRoomThumbnail: () => mockFeed }));

const scope = { serverId: 'second-instance', userId: 'second-account' };
const mara = personLight({ userId: 'mara', name: 'Mara', status: 'online' });
const priya = personLight({ userId: 'priya', name: 'Priya', status: 'online' });
const room = voiceRoomLight({
  scope, guildId: 'guild', channelId: 'voice', name: 'The lounge',
  occupants: [{ person: mara }, { person: priya }], nowMs: 1,
});
const building = buildingLight({ scope, guildId: 'guild', name: 'Old friends', rooms: [room], members: [mara, priya], memberCount: 2 });
const handlers = () => ({ onOpenBuilding: vi.fn(), onOpenRoom: vi.fn(), onJoinRoom: vi.fn() });

beforeEach(() => {
  mockFeed.frame = null;
  mockFeed.state = { live: false, reason: 'no-publisher', label: 'LIVE' };
});

describe('people on Home server cards', () => {
  it('names the call and its participants without reserving an empty media preview', () => {
    const { container } = render(<HomeBuildingCard building={building} mentions={new Map()} {...handlers()} />);
    expect(screen.getByRole('button', { name: 'The lounge' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'In The lounge' })).toBeInTheDocument();
    expect(screen.getByText('Mara')).toBeVisible();
    expect(screen.getByText('Priya')).toBeVisible();
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('.pc-thumb-glow')).toBeNull();
  });

  it('preserves the account and server for opening a server, opening a call, and joining voice', () => {
    const on = handlers();
    render(<HomeBuildingCard building={building} mentions={new Map()} {...on} />);
    fireEvent.click(screen.getByRole('button', { name: 'Old friends' }));
    fireEvent.click(screen.getByRole('button', { name: 'The lounge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    expect(on.onOpenBuilding).toHaveBeenCalledWith(building);
    expect(on.onOpenRoom).toHaveBeenCalledWith(building, room);
    expect(on.onJoinRoom).toHaveBeenCalledWith(building, room);
  });

  it('renders actual sampled media alongside people once the feed can provide it', () => {
    mockFeed.state = { live: true, reason: null, label: 'LIVE · Mara is sharing a screen' };
    mockFeed.frame = { bitmap: {} as ImageBitmap, width: 2, height: 2, capturedAt: 0 };
    const { container } = render(<HomeBuildingCard building={building} mentions={new Map()} {...handlers()} />);
    expect(container.querySelector('canvas')).toBeInTheDocument();
    expect(screen.getByText('Mara')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Join voice' })).toBeInTheDocument();
  });
});
