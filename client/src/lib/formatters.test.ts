import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { formatTimestamp, wallClock } from './formatters';

describe('the product has one wall clock', () => {
  // "Today" is relative to the clock, so pin the clock. Without this the
  // suite passed only on the day it was written.
  const today = new Date(2026, 8, 13, 12, 0, 0, 0);
  const at = (h: number, m: number) => new Date(2026, 8, 13, h, m, 0, 0);

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(today);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('writes the meridiem in lower case, everywhere', () => {
    // The timeline used to render "2:28 PM" while the Lobby rendered "2:28 pm".
    expect(wallClock(at(14, 28))).toMatch(/^2:28\s?pm$/);
    expect(wallClock(at(9, 5))).toMatch(/^9:05\s?am$/);
  });

  it('is the clock the message timestamp is built from', () => {
    expect(formatTimestamp(at(14, 28).toISOString())).toMatch(/^Today at 2:28\s?pm$/);
  });

  it('renders nothing for a date it cannot read', () => {
    expect(wallClock('not a date')).toBe('');
  });
});
