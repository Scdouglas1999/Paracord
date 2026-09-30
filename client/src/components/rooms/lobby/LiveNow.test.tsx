import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { personLight, voiceRoomLight } from '../../../lib/attention/light';
import { LiveNow } from './LiveNow';
import { liveNow } from './liveNowModel';
import { toHomeEvent, type HomeEvent } from './useUpcomingEvents';

const scope = { serverId: 'instance', userId: 'me' };
const NOW = Date.parse('2026-09-22T18:00:00Z');

function person(userId: string, speaking = false) {
  return personLight({ userId, name: userId, status: 'online', inRoom: true, speaking, roomName: 'room' });
}

function room(channelId: string, people: Array<{ id: string; speaking?: boolean }>, selfUserId?: string) {
  return voiceRoomLight({
    scope,
    selfUserId,
    guildId: 'guild',
    channelId,
    name: channelId,
    occupants: people.map(({ id, speaking = false }) => ({ person: person(id, speaking), speaking })),
    nowMs: NOW,
  });
}

const handlers = () => ({ onJoinRoom: vi.fn(), onOpenChannel: vi.fn(), onRsvp: vi.fn() });

function renderLive(rooms: ReturnType<typeof room>[], events: HomeEvent[] = [], on = handlers(), voiceRooms = rooms) {
  return {
    on,
    ...render(
      <MemoryRouter>
        <LiveNow
          guildId="guild"
          live={liveNow({ rooms, stageChannelIds: new Set(), events, games: [] })}
          voiceRooms={voiceRooms}
          nowMs={NOW}
          channelName={() => null}
          {...on}
        />
      </MemoryRouter>,
    ),
  };
}

const row = (name: string) => screen.getByRole('listitem', { name });

describe('live rows', () => {
  it('draws the talking waveform only on the room where somebody is talking', () => {
    const { container } = renderLive([
      room('Lounge', [{ id: 'mara', speaking: true }, { id: 'priya' }]),
      room('Studio', [{ id: 'jonas' }, { id: 'ken' }, { id: 'lena' }]),
    ]);
    expect(row('Lounge, live').querySelector('.glass-wave')).not.toBeNull();
    // People in the call, nobody talking: live, but no waveform.
    expect(row('Studio, live').querySelector('.glass-wave')).toBeNull();
    expect(container.querySelectorAll('.glass-live')).toHaveLength(2);
  });

  it('stops drawing it when the talking stops', () => {
    const { rerender } = renderLive([room('Lounge', [{ id: 'mara', speaking: true }])]);
    expect(row('Lounge, live').querySelector('.glass-wave')).not.toBeNull();
    const quiet = [room('Lounge', [{ id: 'mara' }])];
    rerender(
      <MemoryRouter>
        <LiveNow
          guildId="guild"
          live={liveNow({ rooms: quiet, stageChannelIds: new Set(), events: [], games: [] })}
          voiceRooms={quiet}
          nowMs={NOW}
          channelName={() => null}
          {...handlers()}
        />
      </MemoryRouter>,
    );
    expect(row('Lounge, live').querySelector('.glass-wave')).toBeNull();
  });

  it('follows the faces: a speaking flag on somebody offline does not count', () => {
    const offline = personLight({ userId: 'ghost', name: 'ghost', status: 'offline', inRoom: true, speaking: true });
    const lounge = voiceRoomLight({
      scope,
      guildId: 'guild',
      channelId: 'Lounge',
      name: 'Lounge',
      occupants: [{ person: offline, speaking: true }],
      nowMs: NOW,
    });
    renderLive([lounge]);
    expect(row('Lounge, live').querySelector('.glass-wave')).toBeNull();
  });

  it('says what a stage is, and leaves the amber to live things only', () => {
    const stage = room('Keynote', [{ id: 'mara' }]);
    render(
      <MemoryRouter>
        <LiveNow
          guildId="guild"
          live={liveNow({ rooms: [stage], stageChannelIds: new Set(['Keynote']), events: [], games: [] })}
          voiceRooms={[stage]}
          nowMs={NOW}
          channelName={() => null}
          {...handlers()}
        />
      </MemoryRouter>,
    );
    expect(row('Keynote, live')).toHaveTextContent('Stage');
    expect(screen.getByRole('region', { name: 'Live now' })).toBeInTheDocument();
  });
});

describe('an event that is on now', () => {
  const event = () =>
    toHomeEvent({ id: 'jam', name: 'Jam', scheduled_start: '2026-09-22T17:30:00Z', status: 1 }, NOW) as HomeEvent;

  it('is a plan card that says it is happening now, with the RSVP as text', async () => {
    const { on } = renderLive([], [event()]);
    const card = screen.getByRole('group', { name: 'Event: Jam' });
    expect(card).toHaveTextContent('Happening now');
    await userEvent.click(within(card).getByRole('button', { name: 'Take the spot' }));
    expect(on.onRsvp).toHaveBeenCalledWith('jam');
  });

  it('opens its channel instead when it has one', async () => {
    const on = handlers();
    const withChannel = { ...event(), channelId: 'stage-1' };
    render(
      <MemoryRouter>
        <LiveNow
          guildId="guild"
          live={liveNow({ rooms: [], stageChannelIds: new Set(), events: [withChannel], games: [] })}
          voiceRooms={[]}
          nowMs={NOW}
          channelName={() => 'Stage'}
          {...on}
        />
      </MemoryRouter>,
    );
    const card = screen.getByRole('group', { name: 'Event: Jam' });
    expect(card).toHaveTextContent('in Stage');
    await userEvent.click(within(card).getByRole('button', { name: 'Open' }));
    expect(on.onOpenChannel).toHaveBeenCalledWith('stage-1');
  });
});

describe('the way in', () => {
  it('offers to join a call you are not in, and to return to one you are', () => {
    renderLive([
      room('Lounge', [{ id: 'mara' }]),
      room('Studio', [{ id: 'me' }, { id: 'ken' }], 'me'),
    ]);
    expect(screen.getByRole('button', { name: 'Join Lounge' })).toHaveTextContent('Join');
    expect(screen.getByRole('button', { name: 'Return Studio' })).toHaveTextContent('Return');
    expect(screen.queryByRole('button', { name: 'Join Studio' })).not.toBeInTheDocument();
  });

  it('puts the one cream button on the first call and glass on the rest', () => {
    renderLive([room('Lounge', [{ id: 'mara' }, { id: 'priya' }]), room('Studio', [{ id: 'jonas' }])]);
    expect(screen.getByRole('button', { name: 'Join Lounge' })).toHaveClass('glass-btn--primary');
    expect(screen.getByRole('button', { name: 'Join Studio' })).toHaveClass('glass-btn--glass');
  });

  it('hands the row to Join as the element the walk-in starts from', async () => {
    const { on } = renderLive([room('Lounge', [{ id: 'mara' }])]);
    await userEvent.click(screen.getByRole('button', { name: 'Join Lounge' }));
    expect(on.onJoinRoom).toHaveBeenCalledTimes(1);
    const [joined, origin] = on.onJoinRoom.mock.calls[0];
    expect(joined.channelId).toBe('Lounge');
    expect(origin).toBe(row('Lounge, live'));
  });

  it('opens a room from its body without joining it', async () => {
    const { on } = renderLive([room('Lounge', [{ id: 'mara' }])]);
    await userEvent.click(screen.getByRole('button', { name: 'Open Lounge' }));
    expect(on.onOpenChannel).toHaveBeenCalledWith('Lounge');
    expect(on.onJoinRoom).not.toHaveBeenCalled();
  });
});

describe('when nothing is live', () => {
  it('lists the voice channels as buttons and says nobody is in voice', async () => {
    const empty = room('Lounge', []);
    const { on } = renderLive([], [], handlers(), [empty]);
    expect(screen.getByText('Nobody in voice')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Join Lounge' }));
    expect(on.onJoinRoom).toHaveBeenCalled();
  });

  it('draws nothing when there are no voice channels either', () => {
    const { container } = renderLive([], [], handlers(), []);
    expect(container).toBeEmptyDOMElement();
  });
});
