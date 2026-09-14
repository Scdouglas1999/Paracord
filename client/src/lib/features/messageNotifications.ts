/**
 * Whether an arriving message is allowed to raise a desktop notification.
 *
 * The gateway used to pop one for *every* message that was not yours and not
 * in the focused channel, consulting nothing but the global "notifications
 * enabled" switch. A building you muted, and a room you set to "nothing from
 * this room" in its own menu (docs/lantern-stage-spec.md §7.1), both went on
 * ringing: the sidebar went quiet and the desktop did not, which is the half
 * of "muted" a person actually notices.
 *
 * The levels are the server's own — 0 every message, 1 only mentions, 2
 * nothing — and a room that holds no opinion follows its building, exactly as
 * the room menu and the unified merge already read them.
 */

import type { NotificationLevel, NotificationSetting } from '../../api/notificationSettings';

/**
 * The level in force for a room: its own when it has one, otherwise its
 * building's, otherwise "every message".
 *
 * `muted_now` is the server's resolved answer to "has this timed mute lapsed",
 * so a mute that has expired stops silencing the room without a refresh.
 */
export function effectiveNotificationLevel(
  room: NotificationSetting | undefined,
  building: NotificationSetting | undefined,
): NotificationLevel {
  if (room) return room.muted_now ? 2 : room.level;
  if (building) return building.muted_now ? 2 : building.level;
  return 0;
}

/**
 * Does this message address the reader?
 *
 * Deliberately a *local* read of the message text, and used only to decide
 * whether this client's own desktop may beep. The authoritative mention count
 * still comes from `MESSAGE_MENTION`, which the server targets at real
 * recipients — message text never grants mention permission, and nothing here
 * writes a count.
 */
export function messageAddressesReader(
  message: { content?: string | null } | null | undefined,
  readerId: string | null | undefined,
  suppressEveryone = false,
): boolean {
  const content = String(message?.content ?? '');
  if (!content) return false;
  if (readerId && (content.includes(`<@${readerId}>`) || content.includes(`<@!${readerId}>`))) {
    return true;
  }
  if (suppressEveryone) return false;
  return /@everyone\b/.test(content) || /@here\b/.test(content);
}

export function shouldNotifyForMessage(level: NotificationLevel, addressesReader: boolean): boolean {
  if (level === 2) return false;
  if (level === 1) return addressesReader;
  return true;
}
