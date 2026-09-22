import { describe, expect, it } from 'vitest';
import { boardDay, boardDayFromParam, compactDate, emptyDayPhrase, sportsTitle } from './boardDate';

const now = new Date(2026, 8, 22);

describe('board dates', () => {
  it('names yesterday, today, and a Saturday, and builds the query', () => {
    expect(boardDay(0, now).label).toBe('Today');
    expect(boardDay(-1, now)).toMatchObject({ iso: '2026-09-21', compact: '20260921', label: 'Yesterday' });
    expect(boardDay(1, now).label).toBe('Tomorrow');
    expect(boardDay(-2, now).label).toBe('Sun, Sep 20');
    expect(compactDate('2026-09-21')).toBe('20260921');
    expect(sportsTitle(boardDay(0, now))).toBe('Sports');
    expect(sportsTitle(boardDay(-1, now))).toBe('Sports · Yesterday');
    expect(emptyDayPhrase(boardDay(-2, now))).toBe('on Sun, Sep 20');
  });

  it('treats a missing or out-of-window link as today', () => {
    expect(boardDayFromParam(null, now).offset).toBe(0);
    expect(boardDayFromParam('nope', now).offset).toBe(0);
    expect(boardDayFromParam('2020-01-01', now).offset).toBe(0);
    expect(boardDayFromParam('2026-09-21', now).offset).toBe(-1);
  });
});
