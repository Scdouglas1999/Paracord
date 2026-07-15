import { hasPermission, Permissions } from '../types';
import { getCachedRolePermissions } from '../hooks/usePermissions';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';

const ALL_PERMISSIONS = BigInt('0x7FFFFFFFFFFFFFFF');

/**
 * Any of these permissions (or guild admin/owner) may open space settings.
 * Keep in sync with GuildSettingsPage section gates — do not surface the entry
 * to members who would only hit the locked screen.
 */
export function canAccessGuildSettings(permissions: bigint, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return (
    hasPermission(permissions, Permissions.MANAGE_GUILD) ||
    hasPermission(permissions, Permissions.MANAGE_CHANNELS) ||
    hasPermission(permissions, Permissions.MANAGE_ROLES) ||
    hasPermission(permissions, Permissions.BAN_MEMBERS) ||
    hasPermission(permissions, Permissions.KICK_MEMBERS) ||
    hasPermission(permissions, Permissions.VIEW_AUDIT_LOG) ||
    hasPermission(permissions, Permissions.MANAGE_WEBHOOKS) ||
    hasPermission(permissions, Permissions.MANAGE_EMOJIS) ||
    hasPermission(permissions, Permissions.CREATE_INSTANT_INVITE)
  );
}

/**
 * Sync check for context menus / command palette where hooks are unavailable.
 * Uses owner status plus the role-permission cache; if roles have not been
 * loaded yet for a non-owner, returns false (do not advertise settings).
 */
export function canAccessGuildSettingsSync(guildId: string): boolean {
  const userId = useAuthStore.getState().user?.id ?? null;
  if (!userId) return false;

  const guild = useGuildStore.getState().guilds.find((g) => g.id === guildId);
  if (!guild) return false;

  if (String(guild.owner_id) === String(userId)) {
    return canAccessGuildSettings(ALL_PERMISSIONS, true);
  }

  const rolePermissions = getCachedRolePermissions(guildId);
  if (!rolePermissions) return false;

  const members = useMemberStore.getState().members.get(guildId);
  const me = members?.find((member) => String(member.user.id) === String(userId));
  if (!me) return false;

  let permissions = 0n;
  for (const roleId of me.roles) {
    permissions |= rolePermissions.get(String(roleId)) ?? 0n;
  }
  const isAdmin = hasPermission(permissions, Permissions.ADMINISTRATOR);
  return canAccessGuildSettings(permissions, isAdmin);
}
