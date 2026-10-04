import { useCallback, type MouseEvent } from 'react';
import { AtSign, Bell, BellOff, CheckCheck, Link2 } from 'lucide-react';

import { extractApiError } from '../api/client';
import { writeClipboardText } from '../lib/clipboard';
import { markRoomRead } from '../lib/guildActions';
import { toast } from '../stores/toastStore';
import type { ContextMenuItem } from '../components/ui/ContextMenu';
import type { RoomLight } from '../lib/attention/light';
import { useRoomNotifications } from './useRoomNotifications';

/** What a room's menu needs to know of its room: a `RoomLight` has all of it, and so does any channel the sidebar lists. */
export type RoomMenuTarget = Pick<RoomLight, 'channelId' | 'scope' | 'guildId' | 'name'>;

/** Copy the link to a channel (`/app/guilds/<g>/channels/<c>`) and say so. */
export function copyChannelLink(target: Pick<RoomMenuTarget, 'channelId' | 'guildId'>): void {
  const path = `/app/guilds/${target.guildId}/channels/${target.channelId}`;
  const link = typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString();
  void writeClipboardText(link)
    .then(() => toast.success('Link copied.'))
    .catch((error) => toast.error(`Could not copy the link: ${extractApiError(error)}`));
}

/**
 * The room menu (docs/lantern-stage-spec.md §7.1, §7.3).
 *
 * Three notification levels and a fourth state — "follow the building" — plus
 * the two things you otherwise have to open the room to do: mark it read, copy
 * its link. The level in force is a checked `menuitemradio`, so the menu says
 * what the setting currently *is* rather than only what it could be.
 *
 * It lives here rather than in the sidebar because a room has **two** doors.
 * The Buildings column is the desktop's; a phone never renders that column at
 * all and reaches its rooms through the Lobby, so for one form factor out of
 * two there was no way to mute a room, silence it, or mark it read. One builder,
 * both surfaces — the menu cannot drift between them.
 */
export function useRoomMenu(): (room: RoomMenuTarget) => ContextMenuItem[] {
  const roomNotifications = useRoomNotifications();

  return useCallback(
    (room: RoomMenuTarget): ContextMenuItem[] => {
      const reference = { id: room.channelId, scope: room.scope, name: room.name };
      const level = roomNotifications.levelOf(reference);
      const busy = roomNotifications.savingRoom(reference);
      const notify = (
        label: string,
        icon: ContextMenuItem['icon'],
        value: Parameters<typeof roomNotifications.setLevel>[1],
      ): ContextMenuItem => ({
        label,
        icon,
        selected: level === value,
        disabled: busy,
        action: () => roomNotifications.setLevel(reference, value),
      });

      return [
        notify('Every message', <Bell size={16} />, 0),
        notify('Only when you’re mentioned', <AtSign size={16} />, 1),
        notify('Nothing from this channel', <BellOff size={16} />, 2),
        {
          label: 'Follow the server',
          description: 'Use whatever this server is set to.',
          selected: level === null,
          disabled: busy,
          action: () => roomNotifications.setLevel(reference, null),
        },
        { divider: true, label: '', action: () => {} },
        {
          label: 'Mark channel as read',
          icon: <CheckCheck size={16} />,
          action: () => {
            void markRoomRead(reference).catch((error) =>
              toast.error(`Failed to mark ${room.name} as read: ${extractApiError(error)}`),
            );
          },
        },
        {
          label: 'Copy link to channel',
          icon: <Link2 size={16} />,
          action: () => copyChannelLink(room),
        },
      ];
    },
    [roomNotifications],
  );
}

/**
 * Where to put the menu when the pointer did not say.
 *
 * `useContextMenu` opens at the event's client coordinates, which is exactly
 * right for a right-click and for the `contextmenu` Chromium raises after a long
 * touch press. A **button** that opens the same menu has no such point when it
 * is activated from the keyboard — Enter and Space report (0, 0), which would
 * drop the menu in the top-left corner of the window. Anchor it under the
 * control instead, which is where it would have appeared for a tap.
 */
export function menuEventAt(event: MouseEvent<HTMLElement>): MouseEvent {
  if (event.clientX !== 0 || event.clientY !== 0) return event;
  const box = event.currentTarget.getBoundingClientRect();
  return {
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    clientX: box.left,
    clientY: box.bottom,
  } as unknown as MouseEvent;
}
