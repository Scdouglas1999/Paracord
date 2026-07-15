import { describe, expect, it } from 'vitest';
import { displayName, userHandle } from './displayName';

describe('displayName', () => {
  it('prefers a server nickname over the profile display name and username', () => {
    expect(displayName({ username: 'handle', display_name: 'Profile' }, 'Server Nick')).toBe('Server Nick');
  });

  it('falls back through display name, username, and a safe unknown label', () => {
    expect(displayName({ username: 'handle', display_name: 'Profile' })).toBe('Profile');
    expect(displayName({ username: 'handle' })).toBe('handle');
    expect(displayName(undefined)).toBe('Unknown User');
  });

  it('keeps the username as the account handle', () => {
    expect(userHandle({ username: 'handle', display_name: 'Profile' })).toBe('handle');
  });
});
