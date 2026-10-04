import { describe, expect, it } from 'vitest';

import { defaultServerName, inviteCodeOf } from './useAddServer';

describe('inviteCodeOf', () => {
  it('reads the code at the end of a link, or takes the code as it is', () => {
    expect(inviteCodeOf('https://paracord.gg/hTKzmak')).toBe('hTKzmak');
    expect(inviteCodeOf('  hTKzmak  ')).toBe('hTKzmak');
    expect(inviteCodeOf('paracord.gg/invite/abc123')).toBe('abc123');
  });

  it('keeps what it was given when a link ends in a slash', () => {
    expect(inviteCodeOf('https://paracord.gg/hTKzmak/')).toBe('https://paracord.gg/hTKzmak/');
  });
});

describe('defaultServerName', () => {
  it('suggests the person\'s server, or "My" before their name is known', () => {
    expect(defaultServerName('ada')).toBe("ada's server");
    expect(defaultServerName(null)).toBe("My's server");
    expect(defaultServerName('')).toBe("My's server");
  });
});
