import { describe, expect, it } from 'vitest';

import type { VoiceState } from '../../../types';
import { occupantOf, orderOccupants, rosterState, type PillOccupant } from './model';

function state(userId: string, over: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId,
    session_id: `session-${userId}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    username: userId,
    display_name: userId[0].toUpperCase() + userId.slice(1),
    ...over,
  };
}

describe('who is in the channel', () => {
  const ctx = { selfUserId: 'me', people: undefined };

  it('marks talking, sharing, muted and listening; you are "You"', () => {
    const talking = occupantOf(state('brendan'), ctx, true);
    expect(talking).toMatchObject({ name: 'Brendan', talking: true, sharing: false, muted: false });
    expect(occupantOf(state('vincent', { self_stream: true }), ctx, false).sharing).toBe(true);
    expect(occupantOf(state('nick', { self_mute: true }), ctx, true)).toMatchObject({ muted: true, talking: false });
    expect(occupantOf(state('me', { mode: 'listen' }), ctx, true)).toMatchObject({ name: 'You', listening: true, talking: false, self: true });
    // A listener sends nothing, so it is never sharing.
    expect(occupantOf(state('x', { mode: 'listen', self_stream: true }), ctx, false).sharing).toBe(false);
  });

  it("prefers the roster's name for a person (a voice state carries a username)", () => {
    const people = new Map([['brendan', { name: 'Brendan', avatar: 'hash-b' }]]);
    const person = occupantOf(state('brendan', { username: 'brendan', display_name: undefined, avatar_hash: null }), { selfUserId: 'me', people }, false);
    expect(person).toMatchObject({ name: 'Brendan', avatar: 'hash-b' });
    // Nobody in the roster: the voice state's own name.
    expect(occupantOf(state('luke', { display_name: null, username: 'luke' }), { selfUserId: 'me', people }, false).name).toBe('luke');
  });

  it('puts people who joined first and listeners after, each in the order given', () => {
    const list = ['a', 'b', 'c', 'd'].map((id, index) => occupantOf(state(id, index % 2 ? { mode: 'listen' } : {}), ctx, false));
    expect(orderOccupants(list).map((person) => person.userId)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('says what each person is doing (§5)', () => {
    const person = (over: Partial<PillOccupant>): PillOccupant => ({
      userId: 'u',
      name: 'U',
      avatar: null,
      self: false,
      listening: false,
      muted: false,
      sharing: false,
      streamStartedAt: null,
      talking: false,
      ...over,
    });
    expect(rosterState(person({ sharing: true }))).toEqual({ text: 'Sharing screen', tone: 'amber' });
    expect(rosterState(person({ talking: true }))).toEqual({ text: 'Talking', tone: 'amber' });
    expect(rosterState(person({ muted: true }))).toEqual({ text: 'Muted', tone: 'dim' });
    expect(rosterState(person({ listening: true, muted: true }))).toEqual({ text: 'Listening in', tone: 'dim' });
    expect(rosterState(person({ self: true }))).toEqual({ text: 'Mic on', tone: 'ink' });
    expect(rosterState(person({}))).toEqual({ text: 'Mic on', tone: 'dim' });
    // Sharing wins over talking: the ring is amber for both.
    expect(rosterState(person({ sharing: true, talking: true })).text).toBe('Sharing screen');
  });
});

describe('who began the stream', () => {
  it('stamps when a stream began, and says nothing it was not told', () => {
    const ctx = { selfUserId: 'me', people: undefined };
    expect(occupantOf(state('a', { self_stream: true, self_stream_started_at: '2026-10-01T20:00:00Z' }), ctx, false).streamStartedAt).toBe(
      Date.parse('2026-10-01T20:00:00Z'),
    );
    expect(occupantOf(state('b', { self_stream: true }), ctx, false).streamStartedAt).toBeNull();
    // Not sharing: the stamp means nothing.
    expect(occupantOf(state('c', { self_stream_started_at: '2026-10-01T20:00:00Z' }), ctx, false).streamStartedAt).toBeNull();
  });
});
