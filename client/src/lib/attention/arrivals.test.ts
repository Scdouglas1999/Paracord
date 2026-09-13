import { describe, expect, it } from 'vitest';

import { diffOccupancy, mergeBurst, noCrossings, occupancyOf } from './arrivals';

const rooms = (entries: Record<string, string[]>) =>
  new Map(Object.entries(entries).map(([room, people]) => [room, new Set(people)]));

describe('who just walked in (§5.1)', () => {
  it('names the person, the room, and whether the room lit up with them', () => {
    const delta = diffOccupancy(rooms({ '2001': ['mara'] }), rooms({ '2001': ['mara', 'tomas'] }));
    expect(delta.arrivals).toEqual([{ userId: 'tomas', roomId: '2001', roomLitUp: false }]);
    expect(delta.departures).toEqual([]);

    const firstIn = diffOccupancy(rooms({ '2001': [] }), rooms({ '2001': ['tomas'] }));
    expect(firstIn.arrivals[0].roomLitUp).toBe(true);
  });

  it('is the mirror on the way out, and says when the room went dark', () => {
    const delta = diffOccupancy(rooms({ '2001': ['mara', 'tomas'] }), rooms({ '2001': ['mara'] }));
    expect(delta.departures).toEqual([{ userId: 'tomas', roomId: '2001', roomWentDark: false }]);

    const lastOut = diffOccupancy(rooms({ '2001': ['tomas'] }), rooms({ '2001': [] }));
    expect(lastOut.departures[0].roomWentDark).toBe(true);

    // A room that dropped out of the snapshot entirely emptied out.
    const gone = diffOccupancy(rooms({ '2001': ['tomas'] }), rooms({}));
    expect(gone.departures).toEqual([{ userId: 'tomas', roomId: '2001', roomWentDark: true }]);
  });

  it('never reports your own join — that is Moment 2, and it already animated', () => {
    const delta = diffOccupancy(
      rooms({ '2001': ['mara'] }),
      rooms({ '2001': ['mara', 'me'] }),
      { selfUserId: 'me' },
    );
    expect(noCrossings(delta)).toBe(true);
  });

  it('does not turn the first load of a building into a burst of arrivals', () => {
    // No previous snapshot at all…
    expect(noCrossings(diffOccupancy(null, rooms({ '2001': ['mara', 'priya'] })))).toBe(true);
    // …and an explicit baseline, for a scope that just changed underneath us.
    expect(
      noCrossings(
        diffOccupancy(rooms({}), rooms({ '2001': ['mara'] }), { baseline: true }),
      ),
    ).toBe(true);
  });

  it('a room appearing in the snapshot IS the room lighting up', () => {
    // The voice store only carries rooms with somebody in them, so the first
    // person into a dark room shows up as a brand-new key. That is the arrival
    // the whole moment is drawn around; treating it as "new data" would drop it.
    const delta = diffOccupancy(rooms({ '2001': ['mara'] }), rooms({ '2001': ['mara'], '2002': ['ren'] }));
    expect(delta.arrivals).toEqual([{ userId: 'ren', roomId: '2002', roomLitUp: true }]);
  });

  it('reports nothing when nothing moved', () => {
    const same = rooms({ '2001': ['mara', 'priya'] });
    expect(noCrossings(diffOccupancy(same, rooms({ '2001': ['mara', 'priya'] })))).toBe(true);
  });

  it('reads the voice store shape', () => {
    const occupancy = occupancyOf(
      new Map([['2001', [{ user_id: 'mara' }, { user_id: 'priya' }]]]),
    );
    expect([...(occupancy.get('2001') ?? [])]).toEqual(['mara', 'priya']);
  });
});

describe('a burst is one choreography (§5.1)', () => {
  it('appends newcomers and never queues the same person twice', () => {
    const first = mergeBurst([], [{ userId: 'a', roomId: '1' }, { userId: 'b', roomId: '1' }]);
    const second = mergeBurst(first, [{ userId: 'b', roomId: '1' }, { userId: 'c', roomId: '1' }]);
    expect(second.map((crossing) => crossing.userId)).toEqual(['a', 'b', 'c']);
  });

  it('treats the same person in two rooms as two crossings', () => {
    const merged = mergeBurst([{ userId: 'a', roomId: '1' }], [{ userId: 'a', roomId: '2' }]);
    expect(merged).toHaveLength(2);
  });
});
