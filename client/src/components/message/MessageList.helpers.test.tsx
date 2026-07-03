import { describe, it, expect } from 'vitest';
import { shouldGroup, isDifferentDay, resolveReplyParentId, computeReplyLayout } from './MessageList';
import type { Message } from '../../types';

// Minimal Message factory — only the fields the pure helpers read matter; the
// rest satisfy the type. Overrides are shallow-merged.
function mkMsg(id: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    channel_id: 'c1',
    author: { id: 'u1', username: 'user', discriminator: '0', avatar_hash: null, bot: false, flags: 0 },
    content: '',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactions: [],
    ...extra,
  } as Message;
}

const T0 = '2026-07-01T12:00:00.000Z';
const plus = (base: string, ms: number) => new Date(new Date(base).getTime() + ms).toISOString();

describe('shouldGroup', () => {
  it('returns false when there is no previous message', () => {
    expect(shouldGroup(null, mkMsg('b', { timestamp: T0 }))).toBe(false);
  });

  it('returns false when authors differ', () => {
    const prev = mkMsg('a', { author: { id: 'u1', username: 'a', discriminator: '0' }, timestamp: T0 });
    const curr = mkMsg('b', { author: { id: 'u2', username: 'b', discriminator: '0' }, timestamp: plus(T0, 1000) });
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('groups same author within the 7-minute window', () => {
    const prev = mkMsg('a', { timestamp: T0 });
    const curr = mkMsg('b', { timestamp: plus(T0, 6 * 60 * 1000) });
    expect(shouldGroup(prev, curr)).toBe(true);
  });

  it('does not group at exactly the 7-minute boundary (diff must be strictly less)', () => {
    const prev = mkMsg('a', { timestamp: T0 });
    const curr = mkMsg('b', { timestamp: plus(T0, 7 * 60 * 1000) });
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('does not group beyond the 7-minute window', () => {
    const prev = mkMsg('a', { timestamp: T0 });
    const curr = mkMsg('b', { timestamp: plus(T0, 7 * 60 * 1000 + 1) });
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('falls back to created_at when timestamp is absent', () => {
    const prev = mkMsg('a', { created_at: T0 });
    const curr = mkMsg('b', { created_at: plus(T0, 1000) });
    expect(shouldGroup(prev, curr)).toBe(true);
  });

  it('returns false when a timestamp is missing entirely', () => {
    const prev = mkMsg('a', {});
    const curr = mkMsg('b', { timestamp: T0 });
    expect(shouldGroup(prev, curr)).toBe(false);
  });
});

describe('isDifferentDay', () => {
  // Local-time (no trailing Z) so the comparison is timezone-independent —
  // isDifferentDay compares via Date#toDateString, which is local.
  it('returns false for two instants on the same calendar day', () => {
    expect(isDifferentDay('2026-07-01T01:00:00', '2026-07-01T23:00:00')).toBe(false);
  });

  it('returns true across a day boundary', () => {
    expect(isDifferentDay('2026-07-01T12:00:00', '2026-07-03T12:00:00')).toBe(true);
  });

  it('returns false for unparseable input rather than throwing', () => {
    expect(isDifferentDay('not-a-date', 'also-bad')).toBe(false);
  });
});

describe('resolveReplyParentId', () => {
  it('returns null when no reference is present', () => {
    expect(resolveReplyParentId(mkMsg('a'))).toBeNull();
  });

  it('prefers reference_id', () => {
    const msg = mkMsg('a', { reference_id: '111', referenced_message: mkMsg('222') });
    expect(resolveReplyParentId(msg)).toBe('111');
  });

  it('falls back to referenced_message.id', () => {
    const msg = mkMsg('a', { referenced_message: mkMsg('222') });
    expect(resolveReplyParentId(msg)).toBe('222');
  });

  it('falls back to the legacy referenced_message_id field', () => {
    const msg = mkMsg('a', { referenced_message_id: '333' } as unknown as Partial<Message>);
    expect(resolveReplyParentId(msg)).toBe('333');
  });

  it('coerces a numeric reference to a string', () => {
    const msg = mkMsg('a', { reference_id: 444 as unknown as string });
    expect(resolveReplyParentId(msg)).toBe('444');
  });
});

describe('computeReplyLayout', () => {
  it('assigns depth 0 and no parent to a root message', () => {
    const layout = computeReplyLayout([mkMsg('a')]);
    expect(layout.get('a')).toEqual({ depth: 0, parentId: null });
  });

  it('increments depth along a linear reply chain', () => {
    const messages = [
      mkMsg('a'),
      mkMsg('b', { reference_id: 'a' }),
      mkMsg('c', { reference_id: 'b' }),
    ];
    const layout = computeReplyLayout(messages);
    expect(layout.get('a')).toEqual({ depth: 0, parentId: null });
    expect(layout.get('b')).toEqual({ depth: 1, parentId: 'a' });
    expect(layout.get('c')).toEqual({ depth: 2, parentId: 'b' });
  });

  it('clamps depth to the maximum nest depth on a very long chain', () => {
    const messages: Message[] = [mkMsg('m0')];
    for (let i = 1; i <= 12; i++) {
      messages.push(mkMsg(`m${i}`, { reference_id: `m${i - 1}` }));
    }
    const layout = computeReplyLayout(messages);
    // MAX_REPLY_NEST_DEPTH is 6; deep descendants must not exceed it.
    expect(layout.get('m12')!.depth).toBe(6);
    expect(layout.get('m6')!.depth).toBe(6);
  });

  it('treats a message replying to a missing parent as depth 1', () => {
    const layout = computeReplyLayout([mkMsg('b', { reference_id: 'ghost' })]);
    expect(layout.get('b')).toEqual({ depth: 1, parentId: 'ghost' });
  });

  it('handles a self-referencing message without infinite recursion', () => {
    // The cycle guard returns depth 1 for the revisited node; the outer frame
    // then resolves against it, yielding depth 2. The point is termination and
    // a clamped, finite depth — not a specific small value.
    const layout = computeReplyLayout([mkMsg('a', { reference_id: 'a' })]);
    expect(layout.get('a')).toEqual({ depth: 2, parentId: 'a' });
  });

  it('handles a two-node cycle without infinite recursion', () => {
    const messages = [
      mkMsg('a', { reference_id: 'b' }),
      mkMsg('b', { reference_id: 'a' }),
    ];
    const layout = computeReplyLayout(messages);
    expect(layout.has('a')).toBe(true);
    expect(layout.has('b')).toBe(true);
    // Every resolved depth stays within the clamp.
    for (const entry of layout.values()) {
      expect(entry.depth).toBeGreaterThanOrEqual(0);
      expect(entry.depth).toBeLessThanOrEqual(6);
    }
  });

  it('handles a longer cyclic chain without infinite recursion', () => {
    const messages = [
      mkMsg('a', { reference_id: 'c' }),
      mkMsg('b', { reference_id: 'a' }),
      mkMsg('c', { reference_id: 'b' }),
    ];
    const layout = computeReplyLayout(messages);
    expect(layout.size).toBe(3);
    for (const entry of layout.values()) {
      expect(entry.depth).toBeLessThanOrEqual(6);
    }
  });
});
