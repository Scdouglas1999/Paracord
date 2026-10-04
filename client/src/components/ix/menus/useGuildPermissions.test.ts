import { describe, expect, it } from 'vitest';
import { Permissions, type Member, type Role } from '../../../types';
import { resolveAccess } from './useGuildPermissions';

/** What the account may do in a server, for the menus' gated rows. Roles' bits are or-ed; the owner may do everything. */

const role = (id: string, permissions: bigint): Role =>
  ({ id, guild_id: 'g1', name: id, color: 0, hoist: false, position: 0, permissions: permissions.toString(), mentionable: false, created_at: '' }) as Role;

const member = (id: string, roles: string[]): Member =>
  ({ user: { id, username: id }, roles, joined_at: '', deaf: false, mute: false }) as Member;

describe('resolveAccess', () => {
  it('is everything for the owner, before anything has loaded', () => {
    const access = resolveAccess({ guildId: 'g1', ownerId: 'me', userId: 'me', members: undefined, roles: null });
    expect(access).toMatchObject({ isOwner: true, isAdmin: true, ready: true });
  });

  it('is nothing, and not ready, until both the member list and the roles are known', () => {
    expect(resolveAccess({ guildId: 'g1', ownerId: 'x', userId: 'me', members: undefined, roles: [] })).toMatchObject({ permissions: 0n, ready: false });
    expect(resolveAccess({ guildId: 'g1', ownerId: 'x', userId: 'me', members: [], roles: null })).toMatchObject({ permissions: 0n, ready: false });
  });

  it('or-s the member\'s roles together, plus @everyone (the role whose id is the guild\'s)', () => {
    const access = resolveAccess({
      guildId: 'g1',
      ownerId: 'x',
      userId: 'me',
      members: [member('me', ['mod'])],
      roles: [role('g1', Permissions.CREATE_INSTANT_INVITE), role('mod', Permissions.MANAGE_CHANNELS), role('other', Permissions.MANAGE_GUILD)],
    });
    expect(access.permissions & Permissions.CREATE_INSTANT_INVITE).not.toBe(0n);
    expect(access.permissions & Permissions.MANAGE_CHANNELS).not.toBe(0n);
    // A role the member does not hold adds nothing.
    expect(access.permissions & Permissions.MANAGE_GUILD).toBe(0n);
    expect(access).toMatchObject({ isOwner: false, isAdmin: false, ready: true });
  });

  it('is an administrator with the Administrator bit', () => {
    const access = resolveAccess({
      guildId: 'g1',
      ownerId: 'x',
      userId: 'me',
      members: [member('me', ['admin'])],
      roles: [role('admin', Permissions.ADMINISTRATOR)],
    });
    expect(access.isAdmin).toBe(true);
  });

  it('gives someone missing from the member list nothing (nothing is guessed)', () => {
    const access = resolveAccess({ guildId: 'g1', ownerId: 'x', userId: 'me', members: [member('someone', [])], roles: [role('g1', Permissions.CREATE_INSTANT_INVITE)] });
    expect(access.permissions).toBe(0n);
  });
});
