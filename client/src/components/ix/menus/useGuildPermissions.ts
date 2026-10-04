import { useEffect, useMemo, useState } from 'react';

import { toPermissionBits } from '../../../hooks/usePermissions';
import { fetchGuildRoles } from '../../../lib/permissionDataCache';
import { findScopedGuild } from '../../../lib/guildScope';
import { entityScopeKey, type AccountScope } from '../../../lib/serverScope';
import { useGuildStore } from '../../../stores/guildStore';
import { useMemberStore } from '../../../stores/memberStore';
import { hasPermission, Permissions } from '../../../types';
import type { Member, Role } from '../../../types';

/**
 * What the signed-in account may do in a server, for the account the menu was
 * opened on (a dock's right click names any server, on any instance, so this
 * reads by scope, not by the active server like `usePermissions`).
 *
 * The owner may do everything; otherwise the member's roles' bits are or-ed
 * together. The role list is fetched through the shared cache and the member
 * list through the member store (both fetched once, only when the menu opens);
 * until they arrive the answer is "nothing", never an optimistic guess, so a
 * gated row appears when it is known and not before. The server is still the
 * authority on every action.
 */

export interface GuildAccess {
  permissions: bigint;
  isOwner: boolean;
  isAdmin: boolean;
  /** Roles and the member list are both known. */
  ready: boolean;
}

const ALL_PERMISSIONS = BigInt('0x7FFFFFFFFFFFFFFF');

export function resolveAccess(input: {
  guildId: string;
  ownerId: string | null | undefined;
  userId: string;
  members: readonly Member[] | undefined;
  roles: readonly Role[] | null;
}): GuildAccess {
  const { guildId, ownerId, userId, members, roles } = input;
  if (ownerId != null && String(ownerId) === String(userId)) {
    return { permissions: ALL_PERMISSIONS, isOwner: true, isAdmin: true, ready: true };
  }
  if (!members || !roles) return { permissions: 0n, isOwner: false, isAdmin: false, ready: false };
  const me = members.find((member) => String(member.user.id) === String(userId));
  let permissions = 0n;
  if (me) {
    const byId = new Map(roles.map((role) => [String(role.id), toPermissionBits(role.permissions)]));
    for (const roleId of me.roles ?? []) permissions |= byId.get(String(roleId)) ?? 0n;
    // The @everyone role is the one whose id is the guild's.
    const everyone = roles.find((role) => String(role.id) === String(guildId));
    if (everyone) permissions |= toPermissionBits(everyone.permissions);
  }
  return {
    permissions,
    isOwner: false,
    isAdmin: hasPermission(permissions, Permissions.ADMINISTRATOR),
    ready: true,
  };
}

export function useGuildAccess(guildId: string, scope: AccountScope, enabled = true): GuildAccess {
  const guild = useGuildStore((state) => findScopedGuild(state.guilds, scope, guildId));
  const members = useMemberStore((state) => state.members.get(entityScopeKey(scope, guildId)));
  const [roles, setRoles] = useState<Role[] | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let canceled = false;
    fetchGuildRoles(guildId, scope)
      .then((data) => {
        if (!canceled) setRoles(data);
      })
      .catch(() => {
        // Without roles nothing gated is offered; the rest of the menu still works.
        if (!canceled) setRoles([]);
      });
    if (!useMemberStore.getState().members.has(entityScopeKey(scope, guildId))) {
      void useMemberStore.getState().fetchMembers(guildId, scope);
    }
    return () => {
      canceled = true;
    };
    // `scope` is an object; its identity is its account and instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, scope.serverId, scope.userId, enabled]);

  return useMemo(
    () => resolveAccess({ guildId, ownerId: guild?.owner_id, userId: scope.userId, members, roles }),
    [guildId, guild?.owner_id, scope.userId, members, roles],
  );
}
