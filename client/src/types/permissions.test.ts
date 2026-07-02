import { describe, it, expect } from 'vitest';
import { isAdmin, hasPermission, Permissions, UserFlags } from './index';

describe('isAdmin', () => {
  it('returns true when ADMIN flag is set', () => {
    expect(isAdmin(UserFlags.ADMIN)).toBe(true);
  });

  it('returns true when ADMIN flag is set among other flags', () => {
    expect(isAdmin(UserFlags.ADMIN | 0b10)).toBe(true);
  });

  it('returns false when flags are 0', () => {
    expect(isAdmin(0)).toBe(false);
  });

  it('returns false when ADMIN flag is not set', () => {
    expect(isAdmin(0b10)).toBe(false);
  });
});

describe('hasPermission', () => {
  it('returns true for exact permission match', () => {
    expect(hasPermission(Permissions.SEND_MESSAGES, Permissions.SEND_MESSAGES)).toBe(true);
  });

  it('returns false when permission is not set', () => {
    expect(hasPermission(0n, Permissions.SEND_MESSAGES)).toBe(false);
  });

  it('returns true when ADMINISTRATOR is set (bypasses all checks)', () => {
    expect(hasPermission(Permissions.ADMINISTRATOR, Permissions.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(Permissions.ADMINISTRATOR, Permissions.BAN_MEMBERS)).toBe(true);
    expect(hasPermission(Permissions.ADMINISTRATOR, Permissions.MANAGE_GUILD)).toBe(true);
  });

  it('returns true for combined permissions', () => {
    const perms = Permissions.SEND_MESSAGES | Permissions.VIEW_CHANNEL;
    expect(hasPermission(perms, Permissions.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(perms, Permissions.VIEW_CHANNEL)).toBe(true);
  });

  it('returns false for permissions not in the combination', () => {
    const perms = Permissions.SEND_MESSAGES | Permissions.VIEW_CHANNEL;
    expect(hasPermission(perms, Permissions.BAN_MEMBERS)).toBe(false);
  });

  it('works with all defined permission flags', () => {
    const allPerms = Object.values(Permissions).reduce((acc, perm) => acc | perm, 0n);
    for (const perm of Object.values(Permissions)) {
      expect(hasPermission(allPerms, perm)).toBe(true);
    }
  });
});
