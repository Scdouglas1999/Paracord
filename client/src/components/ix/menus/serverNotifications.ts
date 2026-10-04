import { createNotificationSettingsApi, type NotificationLevel, type SpaceNotificationSetting } from '../../../api/notificationSettings';
import type { GuildReference } from '../../../lib/guildScope';
import { captureScopedOperation } from '../../../lib/operationContext';
import { accountScopeKey } from '../../../lib/serverScope';
import { useNotificationPreferenceStore } from '../../../stores/notificationPreferenceStore';
import { effectiveNotificationLevel } from '../../../lib/features/messageNotifications';

/**
 * A server's own notification level (the server menu's "Notifications" group,
 * docs/index-spec.md §6.2): every message, only mentions, nothing. The store
 * already carries the server's setting and its mute (`setMuted`); the level is
 * the other half of the same record, written here with the same scoped-operation
 * discipline as the store's own saves.
 */

export const SERVER_LEVEL_LABEL: Record<NotificationLevel, string> = {
  0: 'All messages',
  1: 'Only mentions',
  2: 'Nothing',
};

/** The level in force for a server: a timed mute that has not lapsed reads as "nothing". */
export function serverLevel(setting: SpaceNotificationSetting | undefined): NotificationLevel {
  return effectiveNotificationLevel(undefined, setting);
}

export async function setServerLevel(guild: GuildReference, level: NotificationLevel): Promise<void> {
  const context = captureScopedOperation(guild.scope);
  try {
    // Only the level: an unmute or a mute is the row above's business.
    const setting = await createNotificationSettingsApi(() => context.api).setSpace(guild.id, { level });
    context.assertCurrent();
    const key = accountScopeKey(guild.scope);
    useNotificationPreferenceStore.setState((state) => ({
      byAccount: { ...state.byAccount, [key]: { ...state.byAccount[key], [guild.id]: setting } },
    }));
  } finally {
    context.dispose();
  }
}
