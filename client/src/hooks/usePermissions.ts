import { useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { guildApi } from '../api/guilds';
import { hasPermission, Permissions, type ChannelOverwrite } from '../types';
import { OverwriteTargetType } from '../types/channel.types';

const ALL_PERMISSIONS = BigInt('0x7FFFFFFFFFFFFFFF');
const rolePermissionCache = new Map<string, Map<string, bigint>>();

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
    rolePermissionCache.delete(guildId);
    return;
  }
  rolePermissionCache.clear();
}

function getUserIdFromToken(token: string | null): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const decoded = JSON.parse(atob(payload)) as { sub?: string | number };
    if (decoded.sub == null) return null;
    return String(decoded.sub);
  } catch {
    return null;
  }
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
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const guild = useGuildStore((s) =>
    guildId ? s.guilds.find((g) => g.id === guildId) : null
  );
  const members = useMemberStore((s) =>
    guildId ? s.members.get(guildId) : null
  );
  const [rolePermissions, setRolePermissions] = useState<Map<string, bigint>>(
    new Map()
  );
  const [isLoading, setIsLoading] = useState(false);
  const currentUserId = user?.id ?? getUserIdFromToken(token);

  useEffect(() => {
    if (!guildId || !currentUserId) {
      setRolePermissions(new Map());
      setIsLoading(false);
      return;
    }

    const cached = rolePermissionCache.get(guildId);
    if (cached) {
      setRolePermissions(new Map(cached));
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    guildApi
      .getRoles(guildId)
      .then(({ data }) => {
        if (cancelled) return;
        const next = new Map<string, bigint>();
        for (const role of data) {
          next.set(role.id, toPermissionBits(role.permissions));
        }
        rolePermissionCache.set(guildId, new Map(next));
        setRolePermissions(next);
      })
      .catch(() => {
        if (!cancelled) {
          setRolePermissions(new Map());
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [guildId, currentUserId]);

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
        memberRoleIds = me.roles.map(String);
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
