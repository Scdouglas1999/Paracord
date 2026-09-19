import { describe, expect, it } from 'vitest';
import { avatarForScope } from './useScopedAvatar';

const scope = { serverId: 'a', userId: 'viewer' };
const avatar = '/api/v1/users/ada/avatar';

describe('avatars across accounts', () => {
  it('only lets the active account resolve a stored file avatar', () => {
    expect(avatarForScope(avatar, scope, scope)).toBe(avatar);
    expect(avatarForScope(avatar, scope, { serverId: 'b', userId: 'viewer' })).toBeNull();
    expect(avatarForScope(avatar, scope, { serverId: 'a', userId: 'other' })).toBeNull();
    expect(avatarForScope(avatar, scope, null)).toBeNull();
  });

  it('keeps safe embedded avatars available without another account’s image transport', () => {
    const embedded = 'data:image/png;base64,aGVsbG8=';
    expect(avatarForScope(embedded, scope, null)).toBe(embedded);
    expect(avatarForScope('data:image/svg+xml;base64,aGVsbG8=', scope, scope)).toBeNull();
  });

  it('does not borrow a blob or remote URL from another account', () => {
    expect(avatarForScope('blob:another-account', scope, null)).toBeNull();
    expect(avatarForScope('https://other.example/avatar', scope, null)).toBeNull();
  });
});
