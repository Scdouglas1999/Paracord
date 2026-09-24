import { useCurrentAccountScope } from '../hooks/useCurrentUser';
import { entityScopeKey as memberScopeKey } from '../lib/serverScope';
import { useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from './useCurrentUser';
import { useServerListStore } from '../stores/serverListStore';
import { entityScopeKey, LOCAL_SERVER_ID } from '../lib/serverScope';
import { getServerUser } from '../lib/serverIdentity';
import { useGuild } from './useGuilds';
import { useMemberStore } from '../stores/memberStore';
import { fetchGuildRoles } from '../lib/permissionDataCache';
import { hasPermission, Permissions, type ChannelOverwrite } from '../types';
import { OverwriteTargetType } from '../types/channel.types';

const ALL_PERMISSIONS = BigInt('0x7FFFFFFFFFFFFFFF');
const rolePermissionCache = new Map<string, { guildId: string; roles: Map<string, bigint> }>();
let cacheRevision = 0;

export interface UsePermissionsOptions {
  /** When set with `channelOverwrites`, effective bits include channel overwrites. */
  channelId?: string | null;
  /** Channel permission overwrites (e.g. from `channelApi.getOverwrites`). */
  channelOverwrites?: ChannelOverwrite[];
}

/**
 * Guild-scoped permission bits for the current user.
 *
 * By default this aggregates role permissions at the guild level only — channel
 * overwrites are not applied unless `options.channelOverwrites` is supplied.
 * Server-side checks remain authoritative; UI gating may be optimistic without
 * per-channel overwrite data.
 */
export function applyChannelOverwrites(
  basePermissions: bigint,
  guildId: string,
  userId: string,
  roleIds: string[],
  overwrites: ChannelOverwrite[],
): bigint {
  let permissions = basePermissions;
  const roleIdSet = new Set(roleIds.map(String));

  const everyone = overwrites.find(
    (ow) =>
      ow.target_type === OverwriteTargetType.Role &&
      String(ow.target_id) === String(guildId),
  );
  if (everyone) {
    permissions &= ~toPermissionBits(everyone.deny_perms);
    permissions |= toPermissionBits(everyone.allow_perms);
  }

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const ow of overwrites) {
    if (ow.target_type === OverwriteTargetType.Role && roleIdSet.has(String(ow.target_id))) {
      roleDeny |= toPermissionBits(ow.deny_perms);
      roleAllow |= toPermissionBits(ow.allow_perms);
    }
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const memberOw = overwrites.find(
    (ow) =>
      ow.target_type === OverwriteTargetType.Member &&
      String(ow.target_id) === String(userId),
  );
  if (memberOw) {
    permissions &= ~toPermissionBits(memberOw.deny_perms);
    permissions |= toPermissionBits(memberOw.allow_perms);
  }

  return permissions;
}

export function invalidateGuildPermissionCache(guildId?: string) {
  if (guildId) {
    for (const [key, entry] of rolePermissionCache) {
      if (entry.guildId === guildId) rolePermissionCache.delete(key);
    }
    return;
  }
  cacheRevision += 1;
  rolePermissionCache.clear();
}

/** Read-only snapshot of cached role → permission bits for a guild, if loaded. */
export function getCachedRolePermissions(guildId: string, scope?: import('../lib/serverScope').AccountScope): Map<string, bigint> | null {
  const serverId = scope?.serverId ?? useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID;
  const user = getServerUser(serverId);
  if (!user || (scope && scope.userId !== user.id)) return null;
  const cached = rolePermissionCache.get(entityScopeKey({ serverId, userId: user.id }, guildId));
  return cached ? new Map(cached.roles) : null;
}

export function toPermissionBits(value: string | number | undefined): bigint {
  if (value == null) return 0n;
  if (typeof value === 'string') {
    // parseInt+BigInt truncates bits >= 2^53; convert the string directly so
    // the full 64-bit permission set survives.
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return BigInt(value);
}

export function usePermissions(
  guildId: string | null,
  options?: UsePermissionsOptions,
) {
  const user = useCurrentUser();
  const serverId = useServerListStore((state) => state.activeServerId ?? LOCAL_SERVER_ID);
  const guild = useGuild(guildId);
  const memberScope = useCurrentAccountScope();
  const members = useMemberStore((s) =>
    guildId ? (memberScope ? s.members.get(memberScopeKey(memberScope, guildId)) : undefined) : null
  );
  const [roleSnapshot, setRoleSnapshot] = useState<{ key: string | null; roles: Map<string, bigint> }>({ key: null, roles: new Map() });
  const [isLoading, setIsLoading] = useState(false);
  /**
   * Bumped whenever the gateway reports a role change for this guild, to force
   * the fetch effect below to re-run after the cache has been invalidated.
   */
  const [rolesRevision, setRolesRevision] = useState(0);
  const currentUserId = user?.id;
  const scopeKey = guildId && currentUserId ? entityScopeKey({ serverId, userId: currentUserId }, guildId) : null;
  const rolePermissions = useMemo(() => roleSnapshot.key === scopeKey ? roleSnapshot.roles : new Map<string, bigint>(), [roleSnapshot, scopeKey]);

  // `rolePermissionCache` is module-level with no TTL, and the only thing that
  // ever invalidated it was GuildSettings — a screen a demoted moderator has no
  // reason to open. Everyone else kept their old permission bits, and their
  // Delete/Pin/Manage controls, until the app was restarted. Subscribe to the
  // gateway's role events here so every consumer of this hook re-derives.
  useEffect(() => {
    if (!guildId) return;
    const onRolesChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ guild_id?: string }>).detail;
      // Role events carry the guild they belong to; a missing id means the
      // emitter could not attribute it, so invalidate defensively.
      if (detail?.guild_id && String(detail.guild_id) !== String(guildId)) return;
      invalidateGuildPermissionCache(guildId);
      setRolesRevision((current) => current + 1);
    };
    window.addEventListener('paracord:roles-changed', onRolesChanged);
    return () => {
      window.removeEventListener('paracord:roles-changed', onRolesChanged);
    };
  }, [guildId]);

  useEffect(() => {
    if (!guildId || !currentUserId) {
      setRoleSnapshot({ key: scopeKey, roles: new Map() });
      setIsLoading(false);
      return;
    }

    const key = entityScopeKey({ serverId, userId: currentUserId }, guildId);
    const revision = cacheRevision;
    const cached = rolePermissionCache.get(key);
    if (cached) {
      setRoleSnapshot({ key, roles: new Map(cached.roles) });
      setIsLoading(false);
      return;
    }

    let canceled = false;
    setIsLoading(true);
    fetchGuildRoles(guildId)
      .then((data) => {
        if (canceled || revision !== cacheRevision) return;
        const next = new Map<string, bigint>();
        for (const role of data) {
          next.set(role.id, toPermissionBits(role.permissions));
        }
        rolePermissionCache.set(key, { guildId, roles: new Map(next) });
        setRoleSnapshot({ key, roles: next });
      })
      .catch(() => {
        if (!canceled) {
          setRoleSnapshot({ key: scopeKey, roles: new Map() });
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [guildId, currentUserId, serverId, rolesRevision, scopeKey]);

  return useMemo(() => {
    const channelOverwrites = options?.channelOverwrites;
    const channelScoped =
      Boolean(options?.channelId) &&
      channelOverwrites != null &&
      channelOverwrites.length > 0;

    if (!guild) {
      return {
        permissions: 0n,
        isOwner: false,
        isAdmin: false,
        isLoading: false,
        guildLevelOnly: true,
      };
    }

    if (!currentUserId) {
      return {
        permissions: 0n,
        isOwner: false,
        isAdmin: false,
        isLoading: false,
        guildLevelOnly: true,
      };
    }

    const isOwner = String(guild.owner_id) === String(currentUserId);
    let permissions = isOwner ? ALL_PERMISSIONS : 0n;
    let memberRoleIds: string[] = [];
    if (!isOwner) {
      const me = members?.find((member) => String(member.user.id) === String(currentUserId));
      if (me) {
        memberRoleIds = Array.isArray(me.roles) ? me.roles.map(String) : [];
        for (const roleId of memberRoleIds) {
          permissions |= rolePermissions.get(String(roleId)) ?? 0n;
        }
      }
    }
    if (channelScoped && guildId) {
      permissions = applyChannelOverwrites(
        permissions,
        guildId,
        currentUserId,
        isOwner ? [guildId] : memberRoleIds,
        channelOverwrites!,
      );
    }
    const isAdmin =
      isOwner || hasPermission(permissions, Permissions.ADMINISTRATOR);

    return {
      permissions,
      isOwner,
      isAdmin,
      isLoading,
      guildLevelOnly: !channelScoped,
    };
  }, [guild, guildId, currentUserId, members, rolePermissions, isLoading, options?.channelId, options?.channelOverwrites]);
}
