import { describe, expect, it } from 'vitest';
import { authorLabel, groupByMonth } from './groupMedia';

describe('groupByMonth', () => {
  it('puts newest-first items under one header per month, in order', () => {
    const groups = groupByMonth([
      { id: 'a', created_at: '2026-09-20T10:00:00Z' },
      { id: 'b', created_at: '2026-09-02T10:00:00Z' },
      { id: 'c', created_at: '2026-08-30T10:00:00Z' },
    ]);
    expect(groups.map((group) => group.label)).toEqual(['September 2026', 'August 2026']);
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(groups[1].items.map((item) => item.id)).toEqual(['c']);
  });

  it('names the author by display name, then username', () => {
    expect(authorLabel({ display_name: ' Mira ', username: 'mira' })).toBe('Mira');
    expect(authorLabel({ display_name: null, username: 'mira' })).toBe('mira');
  });
});
