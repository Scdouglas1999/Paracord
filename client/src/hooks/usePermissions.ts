import { useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { guildApi } from '../api/guilds';
import { hasPermission, Permissions } from '../types';

const ALL_PERMISSIONS = BigInt('0x7FFFFFFFFFFFFFFF');
const rolePermissionCache = new Map<string, Map<string, bigint>>();

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

export function usePermissions(guildId: string | null) {
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
    if (!guild) {
      return { permissions: 0n, isOwner: false, isAdmin: false, isLoading: false };
    }

    if (!currentUserId) {
      return { permissions: 0n, isOwner: false, isAdmin: false, isLoading: false };
    }

    const isOwner = String(guild.owner_id) === String(currentUserId);
    let permissions = isOwner ? ALL_PERMISSIONS : 0n;
    if (!isOwner) {
      const me = members?.find((member) => String(member.user.id) === String(currentUserId));
      if (me) {
        for (const roleId of me.roles) {
          permissions |= rolePermissions.get(String(roleId)) ?? 0n;
        }
      }
    }
    const isAdmin =
      isOwner || hasPermission(permissions, Permissions.ADMINISTRATOR);

    return { permissions, isOwner, isAdmin, isLoading };
  }, [guild, currentUserId, members, rolePermissions, isLoading]);
}
