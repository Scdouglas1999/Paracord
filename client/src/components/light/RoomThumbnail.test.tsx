import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { personLight, voiceRoomLight } from '../../lib/attention/light';
import { RoomThumbnail } from './RoomThumbnail';

vi.mock('../../hooks/useScopedAvatar', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../hooks/useScopedAvatar')>(),
  useAvatarScope: () => ({ serverId: 'a', userId: 'viewer' }),
}));
// Observe the actual value handed to image transport, independently of whether
// a download ticket happens to be available in this test session.
vi.mock('../../lib/userAvatar', () => ({
  resolveUserAvatarUrl: (avatar: string | null | undefined) => avatar ?? null,
}));

const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII=';
const people = ['Mara', 'Priya', 'Ren', 'Devon', 'Sasha'].map((name, index) => personLight({
  userId: String(index), name, status: 'online', avatar: index === 0 ? AVATAR : null,
}));

function room() {
  return voiceRoomLight({
    scope: { serverId: 'a', userId: 'viewer' }, guildId: 'g', channelId: 'voice', name: 'The lounge',
    occupants: people.map((person) => ({ person })), nowMs: 1,
  });
}

describe('call preview content', () => {
  it('uses real faces and visible names for an audio call, even when media overlays are disabled', () => {
    const { container } = render(<RoomThumbnail room={room()} height={168} showOccupants={false} />);
    expect(screen.getByRole('list', { name: 'In The lounge' })).toBeInTheDocument();
    expect(screen.getByText('Mara')).toBeVisible();
    expect(container.querySelector(`img[src="${AVATAR}"]`)).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeVisible();
    expect(screen.getByText('Ren, Sasha')).toBeInTheDocument();
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('.pc-thumb-glow')).toBeNull();
  });

  it('keeps a compact name-and-avatar row for narrow sidebars with complete names available', () => {
    const call = room();
    call.occupants[0].person = { ...call.occupants[0].person, name: 'A very long familiar display name' };
    const { container } = render(<RoomThumbnail room={call} height={64} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('A very long familiar display name and 4 others')).toBeVisible();
    expect(screen.getByTitle('A very long familiar display name, Mara, Priya, Ren, Sasha')).toBeInTheDocument();
    expect((container.firstElementChild as HTMLElement).style.height).toBe('64px');
  });

  it('preserves a supplied still and a real live frame when available, then returns to faces', () => {
    const call = room();
    const { container, rerender } = render(<RoomThumbnail room={call} still="blob:real-poster" height={168} />);
    expect(container.querySelector('img[src="blob:real-poster"]')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    const frame = { bitmap: {} as ImageBitmap, width: 2, height: 2, capturedAt: 0 };
    const live = { ...call, thumbnail: { live: true, reason: null, label: 'LIVE · Mara is sharing a screen' } };
    rerender(<RoomThumbnail room={live} frame={frame} height={168} />);
    expect(container.querySelector('canvas')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    rerender(<RoomThumbnail room={call} height={168} />);
    expect(container.querySelector('canvas')).toBeNull();
    expect(screen.getByRole('list', { name: 'In The lounge' })).toBeInTheDocument();
  });

  it.each([
    { serverId: 'other-instance', userId: 'viewer' },
    { serverId: 'a', userId: 'other-account' },
  ])('never resolves foreign avatar paths for $serverId/$userId in faces, compact rows, or media overlays', (scope) => {
    const path = '/api/v1/users/mara/avatar';
    const call = voiceRoomLight({
      scope, guildId: 'g', channelId: 'voice', name: 'The lounge', nowMs: 1,
      occupants: [
        { person: personLight({ userId: 'mara', name: 'Mara Okafor', status: 'online', avatar: path }) },
        { person: personLight({ userId: 'priya', name: 'Priya Raman', status: 'online', avatar: AVATAR }) },
      ],
    });
    const { container, rerender } = render(<RoomThumbnail room={call} height={168} />);
    expect(screen.getByText('Mara Okafor')).toBeVisible();
    expect(container.querySelector(`img[src="${path}"]`)).toBeNull();
    expect(container.querySelector(`img[src="${AVATAR}"]`)).toBeInTheDocument();
    rerender(<RoomThumbnail room={call} height={64} />);
    expect(container.querySelector(`img[src="${path}"]`)).toBeNull();
    expect(container.querySelector(`img[src="${AVATAR}"]`)).toBeInTheDocument();
    rerender(<RoomThumbnail room={call} height={168} still="blob:real-poster" />);
    expect(container.querySelector(`img[src="${path}"]`)).toBeNull();
    expect(container.querySelector(`img[src="${AVATAR}"]`)).toBeInTheDocument();
    rerender(<RoomThumbnail room={{ ...call, scope: { serverId: 'a', userId: 'viewer' } }} height={168} />);
    expect(container.querySelector(`img[src="${path}"]`)).toBeInTheDocument();
  });
});
