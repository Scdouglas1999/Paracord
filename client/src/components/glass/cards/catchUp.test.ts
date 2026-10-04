import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../../types';
import { findCatchUp } from './catchUp';

/** Pin the locale: the divider quotes the clock in the reader's own form. */
const RealDateTimeFormat = Intl.DateTimeFormat;
beforeEach(() => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (_locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return new RealDateTimeFormat('en-US', options);
  } as never);
});
afterEach(() => vi.restoreAllMocks());

const EPOCH_MS = Date.UTC(2024, 0, 1);
/** A snowflake minted at a local wall-clock moment. */
const snowflake = (date: Date) => ((BigInt(date.getTime() - EPOCH_MS) << 22n) + 1n).toString();

const msg = (id: string, author: string, extra: Partial<Message> = {}): Message =>
  ({ id, author: { id: author }, content: 'x', timestamp: '2026-10-01T21:00:00', ...extra }) as Message;
const noSystem = () => false;

describe('findCatchUp', () => {
  const messages = [msg('10', 'me'), msg('11', 'a'), msg('12', 'b'), msg('13', 'me'), msg('14', 'a')];

  it('finds the first message of somebody else after the read position, and counts theirs', () => {
    const found = findCatchUp(messages, '10', 'me', noSystem, false);
    expect(found).toMatchObject({ index: 1, count: 3, atLeast: false });
  });

  it('does not count what you wrote yourself, or open on it', () => {
    // Read up to 11: the next is somebody else's (12), yours (13) is not counted.
    expect(findCatchUp(messages, '11', 'me', noSystem, false)).toMatchObject({ index: 2, count: 2 });
    // Only your own after the position: nothing missed.
    expect(findCatchUp([msg('10', 'a'), msg('11', 'me')], '10', 'me', noSystem, false)).toBeNull();
  });

  it('does not count the conversation’s own news', () => {
    const list = [msg('10', 'a'), msg('11', 'a', { type: 6 as never }), msg('12', 'b')];
    const found = findCatchUp(list, '10', 'me', (m) => m.id === '11', false);
    expect(found).toMatchObject({ index: 2, count: 1 });
  });

  it('is null when nothing is unread, or there is no position', () => {
    expect(findCatchUp(messages, '14', 'me', noSystem, false)).toBeNull();
    expect(findCatchUp(messages, null, 'me', noSystem, false)).toBeNull();
    expect(findCatchUp([], '10', 'me', noSystem, false)).toBeNull();
  });

  it('compares ids as numbers, not text ("9" is before "10")', () => {
    const found = findCatchUp([msg('9', 'a'), msg('10', 'a')], '9', 'me', noSystem, false);
    expect(found).toMatchObject({ index: 1, count: 1 });
  });

  it('says "or more" when the history starts inside what you missed and more exists', () => {
    expect(findCatchUp([msg('11', 'a'), msg('12', 'a')], '10', 'me', noSystem, true)).toMatchObject({ index: 0, count: 2, atLeast: true });
    expect(findCatchUp([msg('11', 'a'), msg('12', 'a')], '10', 'me', noSystem, false)).toMatchObject({ atLeast: false });
  });

  it('takes "since" from the position’s own snowflake', () => {
    const readAt = new Date(2026, 9, 1, 20, 58);
    const found = findCatchUp([msg(snowflake(new Date(2026, 9, 1, 21, 2)), 'a')], snowflake(readAt), 'me', noSystem, false);
    expect(found?.since).not.toBeNull();
    expect(new Date(found!.since!).getTime()).toBe(readAt.getTime());
  });
});
