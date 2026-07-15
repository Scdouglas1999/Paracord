import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Permissions } from '../types';
import {
  canAccessGuildSettings,
  canAccessGuildSettingsSync,
} from './guildSettingsAccess';

const ALL_PERMISSIONS = BigInt('0x7FFFFFFFFFFFFFFF');

const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
}));

const guildState = vi.hoisted(() => ({
  guilds: [] as Array<{ id: string; owner_id: string }>,
}));

const memberState = vi.hoisted(() => ({
  members: new Map<string, Array<{ user: { id: string }; roles: string[] }>>(),
}));

const roleCache = vi.hoisted(() => ({
  get: vi.fn<(guildId: string) => Map<string, bigint> | null>(() => null),
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: {
    getState: () => ({ user: authState.user }),
  },
}));

vi.mock('../stores/guildStore', () => ({
  useGuildStore: {
    getState: () => ({ guilds: guildState.guilds }),
  },
}));

vi.mock('../stores/memberStore', () => ({
  useMemberStore: {
    getState: () => ({ members: memberState.members }),
  },
}));

vi.mock('../hooks/usePermissions', () => ({
  getCachedRolePermissions: (guildId: string) => roleCache.get(guildId),
}));

describe('canAccessGuildSettings', () => {
  it('allows guild admins', () => {
    expect(canAccessGuildSettings(0n, true)).toBe(true);
  });

  it('allows manage-guild and related moderation bits', () => {
    expect(canAccessGuildSettings(Permissions.MANAGE_GUILD, false)).toBe(true);
    expect(canAccessGuildSettings(Permissions.BAN_MEMBERS, false)).toBe(true);
    expect(canAccessGuildSettings(Permissions.CREATE_INSTANT_INVITE, false)).toBe(true);
  });

  it('denies members with no management permissions', () => {
    expect(canAccessGuildSettings(Permissions.SEND_MESSAGES, false)).toBe(false);
    expect(canAccessGuildSettings(0n, false)).toBe(false);
  });
});

describe('canAccessGuildSettingsSync', () => {
  beforeEach(() => {
    authState.user = { id: 'user-1' };
    guildState.guilds = [{ id: 'guild-1', owner_id: 'owner-1' }];
    memberState.members = new Map();
    roleCache.get.mockReset();
    roleCache.get.mockReturnValue(null);
  });

  it('allows the space owner', () => {
    guildState.guilds = [{ id: 'guild-1', owner_id: 'user-1' }];
    expect(canAccessGuildSettingsSync('guild-1')).toBe(true);
  });

  it('denies non-owners when role permissions are not cached yet', () => {
    expect(canAccessGuildSettingsSync('guild-1')).toBe(false);
  });

  it('allows members with a cached manage permission', () => {
    memberState.members.set('guild-1', [
      { user: { id: 'user-1' }, roles: ['role-mod'] },
    ]);
    roleCache.get.mockReturnValue(new Map([['role-mod', Permissions.MANAGE_CHANNELS]]));
    expect(canAccessGuildSettingsSync('guild-1')).toBe(true);
  });

  it('denies members whose roles lack management bits', () => {
    memberState.members.set('guild-1', [
      { user: { id: 'user-1' }, roles: ['role-member'] },
    ]);
    roleCache.get.mockReturnValue(new Map([['role-member', Permissions.SEND_MESSAGES]]));
    expect(canAccessGuildSettingsSync('guild-1')).toBe(false);
  });

  it('allows members with ADMINISTRATOR via cached roles', () => {
    memberState.members.set('guild-1', [
      { user: { id: 'user-1' }, roles: ['role-admin'] },
    ]);
    roleCache.get.mockReturnValue(new Map([['role-admin', Permissions.ADMINISTRATOR]]));
    expect(canAccessGuildSettingsSync('guild-1')).toBe(true);
  });

  it('treats owner ALL_PERMISSIONS as accessible', () => {
    expect(canAccessGuildSettings(ALL_PERMISSIONS, true)).toBe(true);
  });
});
