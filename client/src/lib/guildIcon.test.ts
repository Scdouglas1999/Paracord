import { describe, expect, it } from 'vitest';
import { guildInitials, resolveGuildIconUrl } from './guildIcon';

describe('resolveGuildIconUrl', () => {
  it('prefers icon_hash over icon', () => {
    expect(
      resolveGuildIconUrl({
        icon_hash: 'data:image/png;base64,abc',
        icon: 'data:image/png;base64,def',
      }),
    ).toBe('data:image/png;base64,abc');
  });

  it('falls back to icon when icon_hash is missing', () => {
    expect(resolveGuildIconUrl({ icon: 'data:image/png;base64,def' })).toBe(
      'data:image/png;base64,def',
    );
  });

  it('returns null for empty / unsafe values', () => {
    expect(resolveGuildIconUrl(null)).toBeNull();
    expect(resolveGuildIconUrl({ icon_hash: 'not-a-url' })).toBeNull();
  });
});

describe('guildInitials', () => {
  it('builds up to two initials from the space name', () => {
    expect(guildInitials('Emerald HQ')).toBe('EH');
    expect(guildInitials('Solo')).toBe('S');
    expect(guildInitials('')).toBe('?');
  });
});
