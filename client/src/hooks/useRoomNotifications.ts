/**
 * A room's own notification level (docs/lantern-stage-spec.md §7.1).
 *
 * The server has had `PUT`/`DELETE /channels/{id}/notification-settings` and
 * the client has had `notificationSettingsApi.setChannel`/`clearChannel` for
 * as long as buildings have had mute — but nothing ever called them, because
 * rooms had no context menu to call them from. This is the read half; the
 * sidebar's room menu is the write half.
 *
 * Three states, and the third is the point: a room can say "every message",
 * "only when I'm mentioned", or "nothing" — or it can hold no opinion at all
 * and follow its building.
 */

import { useCallback } from 'react';

import { useNotificationPreferenceStore } from '../stores/notificationPreferenceStore';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../lib/serverScope';
import type { NotificationLevel } from '../api/notificationSettings';
import { extractApiError } from '../api/client';
import { toast } from '../stores/toastStore';

/** What a room is set to, or `null` when it simply follows its building. */
export type RoomNotificationLevel = NotificationLevel | null;

export interface RoomNotifications {
  /** The room's own level, or null when it has no override. */
  levelOf: (channel: { id: string; scope: AccountScope }) => RoomNotificationLevel;
  /** True while a change to this room is in flight. */
  savingRoom: (channel: { id: string; scope: AccountScope }) => boolean;
  /** Set the room's level, or pass null to hand it back to its building. */
  setLevel: (
    channel: { id: string; scope: AccountScope; name?: string },
    level: RoomNotificationLevel,
  ) => void;
}

export function useRoomNotifications(): RoomNotifications {
  const channelsByAccount = useNotificationPreferenceStore((state) => state.channelsByAccount);
  const saving = useNotificationPreferenceStore((state) => state.saving);

  const levelOf = useCallback(
    (channel: { id: string; scope: AccountScope }): RoomNotificationLevel => {
      const setting = channelsByAccount[accountScopeKey(channel.scope)]?.[channel.id];
      if (!setting) return null;
      return setting.muted_now ? 2 : setting.level;
    },
    [channelsByAccount],
  );

  const savingRoom = useCallback(
    (channel: { id: string; scope: AccountScope }) =>
      Boolean(saving[entityScopeKey(channel.scope, channel.id)]),
    [saving],
  );

  const setLevel = useCallback(
    (channel: { id: string; scope: AccountScope; name?: string }, level: RoomNotificationLevel) => {
      void useNotificationPreferenceStore
        .getState()
        .setChannelLevel({ id: channel.id, scope: channel.scope }, level)
        .catch((error) =>
          toast.error(
            `Could not change notifications for ${channel.name ?? 'that room'}: ${extractApiError(error)}`,
          ),
        );
    },
    [],
  );

  return { levelOf, savingRoom, setLevel };
}
