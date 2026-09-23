import { describe, expect, it } from 'vitest';

import type { SportsGame } from '../../../api/sports';
import type { RoomLight } from '../../../lib/attention/light';
import { liveNow } from './liveNowModel';
import { toHomeEvent, upcomingEvents, type HomeEvent } from './useUpcomingEvents';

function room(channelId: string, occupants: number, order = 0, talking = 0): RoomLight {
  return {
    key: channelId,
    channelId,
    name: channelId,
    kind: 'voice',
    order,
    occupants: Array.from({ length: occupants }, (_, index) => ({ person: { userId: `${channelId}-${index}` } })),
    talkingCount: talking,
  } as unknown as RoomLight;
}

const NOW = Date.parse('2026-09-22T18:00:00Z');

function event(id: string, start: string, status = 1, end?: string): HomeEvent {
  return toHomeEvent({ id, name: id, scheduled_start: start, scheduled_end: end, status }, NOW) as HomeEvent;
}

describe('liveNow', () => {
  it('is empty when nothing is live', () => {
    const live = liveNow({ rooms: [room('a', 0), room('b', 0)], stageChannelIds: new Set(), events: [], games: [] });
    expect(live.all).toEqual([]);
    expect(live.more).toBe(0);
  });

  it('puts the fullest call first and marks stages', () => {
    const live = liveNow({
      rooms: [room('small', 1), room('big', 4), room('stage', 2)],
      stageChannelIds: new Set(['stage']),
      events: [],
      games: [],
    });
    expect(live.all.map((item) => item.key)).toEqual(['voice:big', 'stage:stage', 'voice:small']);
    expect(live.all[1].kind).toBe('stage');
  });

  it('shows three and counts the rest', () => {
    const live = liveNow({
      rooms: [room('a', 1), room('b', 1), room('c', 1)],
      stageChannelIds: new Set(),
      events: [event('now', '2026-09-22T17:30:00Z')],
      games: [{ id: 'g1', state: 'in' } as SportsGame, { id: 'g2', state: 'pre' } as SportsGame],
    });
    expect(live.shown).toHaveLength(3);
    expect(live.more).toBe(2);
    expect(live.all.map((item) => item.kind)).toEqual(['voice', 'voice', 'voice', 'event', 'game']);
  });
});

describe('the calendar', () => {
  it('knows an event that is happening now', () => {
    expect(event('a', '2026-09-22T17:30:00Z').happeningNow).toBe(true);
    expect(event('b', '2026-09-22T19:00:00Z').happeningNow).toBe(false);
    expect(event('c', '2026-09-22T10:00:00Z', 2).happeningNow).toBe(true);
  });

  it('drops what is over, cancelled or unreadable', () => {
    expect(toHomeEvent({ id: 'a', name: 'a', scheduled_start: '2026-09-22T10:00:00Z', status: 1 }, NOW)).toBeNull();
    expect(toHomeEvent({ id: 'a', name: 'a', scheduled_start: '2026-09-23T10:00:00Z', status: 4 }, NOW)).toBeNull();
    expect(toHomeEvent({ id: 'a', name: 'a', scheduled_start: 'soon' }, NOW)).toBeNull();
    expect(
      toHomeEvent(
        { id: 'a', name: 'a', scheduled_start: '2026-09-22T17:00:00Z', scheduled_end: '2026-09-22T17:30:00Z' },
        NOW,
      ),
    ).toBeNull();
  });

  it('orders what is left by when it starts', () => {
    const list = upcomingEvents(
      [
        { id: 'late', name: 'late', scheduled_start: '2026-09-25T10:00:00Z' },
        { id: 'soon', name: 'soon', scheduled_start: '2026-09-23T10:00:00Z', user_count: 4, user_rsvp: true },
      ],
      NOW,
    );
    expect(list.map((entry) => entry.id)).toEqual(['soon', 'late']);
    expect(list[0].going).toBe(4);
    expect(list[0].youAreGoing).toBe(true);
  });
});
