import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { personLight, voiceRoomLight } from '../../../lib/attention/light';
import { LiveNow } from './LiveNow';
import { liveNow } from './liveNow';
import { toHomeEvent, type HomeEvent } from './useUpcomingEvents';

const scope = { serverId: 'instance', userId: 'me' };
const NOW = Date.parse('2026-09-22T18:00:00Z');

function person(userId: string, speaking = false) {
  return personLight({ userId, name: userId, status: 'online', inRoom: true, speaking, roomName: 'room' });
}

function room(channelId: string, people: Array<{ id: string; speaking?: boolean }>) {
  return voiceRoomLight({
    scope,
    guildId: 'guild',
    channelId,
    name: channelId,
    occupants: people.map(({ id, speaking = false }) => ({ person: person(id, speaking), speaking })),
    nowMs: NOW,
  });
}

function renderLive(rooms: ReturnType<typeof room>[], events: HomeEvent[] = []) {
  return render(
    <MemoryRouter>
      <LiveNow
        guildId="guild"
        live={liveNow({ rooms, stageChannelIds: new Set(), events, games: [] })}
        voiceRooms={rooms}
        phone={false}
        channelName={() => null}
        onJoinRoom={vi.fn()}
        onOpenChannel={vi.fn()}
        onRsvp={vi.fn()}
      />
    </MemoryRouter>,
  );
}

const card = (name: string) => screen.getByRole('article', { name });

describe('live card glow', () => {
  it('breathes only on the card whose channel has somebody talking', () => {
    renderLive([
      room('Lounge', [{ id: 'mara', speaking: true }, { id: 'priya' }]),
      room('Studio', [{ id: 'jonas' }, { id: 'ken' }, { id: 'lena' }]),
    ]);
    expect(card('Lounge, live')).toHaveClass('pc-home-live', 'is-speaking');
    expect(card('Lounge, live')).toHaveAttribute('data-speaking');
    // People in the call, nobody talking: the still live styling, no breath.
    expect(card('Studio, live')).toHaveClass('pc-home-live');
    expect(card('Studio, live')).not.toHaveClass('is-speaking');
    expect(card('Studio, live')).not.toHaveAttribute('data-speaking');
  });

  it('stops breathing when the talking stops', () => {
    const { rerender } = renderLive([room('Lounge', [{ id: 'mara', speaking: true }])]);
    expect(card('Lounge, live')).toHaveClass('is-speaking');
    rerender(
      <MemoryRouter>
        <LiveNow
          guildId="guild"
          live={liveNow({ rooms: [room('Lounge', [{ id: 'mara' }])], stageChannelIds: new Set(), events: [], games: [] })}
          voiceRooms={[room('Lounge', [{ id: 'mara' }])]}
          phone={false}
          channelName={() => null}
          onJoinRoom={vi.fn()}
          onOpenChannel={vi.fn()}
          onRsvp={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(card('Lounge, live')).not.toHaveClass('is-speaking');
  });

  it('follows the avatars: a speaking flag on somebody offline does not count', () => {
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
    expect(card('Lounge, live')).not.toHaveClass('is-speaking');
  });

  it('never breathes on an event card', () => {
    const event = toHomeEvent(
      { id: 'jam', name: 'Jam', scheduled_start: '2026-09-22T17:30:00Z', status: 1 },
      NOW,
    ) as HomeEvent;
    renderLive([], [event]);
    expect(card('Jam, happening now')).toHaveClass('pc-home-live');
    expect(card('Jam, happening now')).not.toHaveClass('is-speaking');
  });
});
