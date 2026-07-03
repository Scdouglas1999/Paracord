import {
  formatDistanceToNow,
  format,
  isToday,
  isYesterday,
  differenceInMinutes,
} from 'date-fns';

// ============ Date/Time Formatters ============

/**
 * Format a date/timestamp as the `YYYY-MM-DDThh:mm` string a native
 * `datetime-local` input expects, in the user's LOCAL wall-clock time.
 *
 * `datetime-local` is timezone-naive, so a control's `value` and its `min`/`max`
 * constraints must both be built this way. Using `toISOString()` (UTC) for `min`
 * mis-constrains users west of UTC — the UTC min reads hours ahead of their
 * local clock and the browser rejects legitimate near-future selections.
 */
export function toDatetimeLocalValue(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * Returns a relative time string like "2 hours ago", "just now", "5 minutes ago".
 */
export function relativeTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return dateStr;
  }
}

/**
 * Formats a timestamp for display next to a message.
 * "Today at 3:45 PM", "Yesterday at 10:00 AM", or "01/15/2025 3:45 PM"
 */
export function formatMessageTimestamp(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const time = format(date, 'h:mm a');
    if (isToday(date)) return `Today at ${time}`;
    if (isYesterday(date)) return `Yesterday at ${time}`;
    return `${format(date, 'MM/dd/yyyy')} ${time}`;
  } catch {
    return dateStr;
  }
}

/**
 * Formats a timestamp for display next to a message using the browser locale.
 * "Today at 3:45 PM", "Yesterday at 10:00 AM", or "1/15/2025 3:45 PM".
 *
 * Unlike {@link formatMessageTimestamp}, this uses locale-aware
 * toLocaleTimeString/toLocaleDateString output. Shared by the message list and
 * search panel; kept locale-based to preserve their existing rendering.
 */
export function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const dateIsToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const dateIsYesterday = date.toDateString() === yesterday.toDateString();

    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (dateIsToday) return `Today at ${time}`;
    if (dateIsYesterday) return `Yesterday at ${time}`;
    return `${date.toLocaleDateString()} ${time}`;
  } catch {
    return iso;
  }
}

/**
 * Formats a full date for message date separators using the browser locale.
 * "Monday, January 15, 2025".
 */
export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Formats a full date for date separators between message groups.
 * "Monday, January 15, 2025"
 */
export function formatDateSeparator(dateStr: string): string {
  try {
    return format(new Date(dateStr), 'EEEE, MMMM d, yyyy');
  } catch {
    return dateStr;
  }
}

/**
 * Returns just the short time (e.g. "3:45 PM") for grouped message timestamps.
 */
export function formatShortTime(dateStr: string): string {
  try {
    return format(new Date(dateStr), 'h:mm a');
  } catch {
    return dateStr;
  }
}

/**
 * Checks if two timestamps are on different calendar days.
 */
export function isDifferentDay(a: string, b: string): boolean {
  try {
    return new Date(a).toDateString() !== new Date(b).toDateString();
  } catch {
    return false;
  }
}

/**
 * Determines if two consecutive messages should be visually grouped
 * (same author, within 7 minutes).
 */
export function shouldGroupMessages(
  prev: { author: { id: string }; created_at?: string; timestamp?: string } | null,
  curr: { author: { id: string }; created_at?: string; timestamp?: string }
): boolean {
  if (!prev) return false;
  if (prev.author.id !== curr.author.id) return false;
  const prevTime = prev.created_at || prev.timestamp;
  const currTime = curr.created_at || curr.timestamp;
  if (!prevTime || !currTime) return false;
  return differenceInMinutes(new Date(currTime), new Date(prevTime)) < 7;
}

// ============ File Size Formatter ============

/**
 * Formats a byte count into a human-readable file size.
 * e.g. 1024 -> "1.0 KB", 1048576 -> "1.0 MB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// ============ Permission Name Formatter ============

const PERMISSION_NAMES: Record<string, string> = {
  CREATE_INSTANT_INVITE: 'Create Invite',
  KICK_MEMBERS: 'Kick Members',
  BAN_MEMBERS: 'Ban Members',
  ADMINISTRATOR: 'Administrator',
  MANAGE_CHANNELS: 'Manage Channels',
  MANAGE_GUILD: 'Manage Server',
  ADD_REACTIONS: 'Add Reactions',
  VIEW_AUDIT_LOG: 'View Audit Log',
  PRIORITY_SPEAKER: 'Priority Speaker',
  STREAM: 'Video',
  VIEW_CHANNEL: 'View Channels',
  SEND_MESSAGES: 'Send Messages',
  SEND_TTS_MESSAGES: 'Send TTS Messages',
  MANAGE_MESSAGES: 'Manage Messages',
  EMBED_LINKS: 'Embed Links',
  ATTACH_FILES: 'Attach Files',
  READ_MESSAGE_HISTORY: 'Read Message History',
  MENTION_EVERYONE: 'Mention @everyone',
  USE_EXTERNAL_EMOJIS: 'Use External Emojis',
  CONNECT: 'Connect',
  SPEAK: 'Speak',
  MUTE_MEMBERS: 'Mute Members',
  DEAFEN_MEMBERS: 'Deafen Members',
  MOVE_MEMBERS: 'Move Members',
  USE_VAD: 'Use Voice Activity',
  CHANGE_NICKNAME: 'Change Nickname',
  MANAGE_NICKNAMES: 'Manage Nicknames',
  MANAGE_ROLES: 'Manage Roles',
  MANAGE_WEBHOOKS: 'Manage Webhooks',
  MANAGE_EMOJIS: 'Manage Emojis',
};

/**
 * Returns a human-readable name for a permission flag key.
 */
export function formatPermissionName(key: string): string {
  return PERMISSION_NAMES[key] || key.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============ Number Formatters ============

/**
 * Formats a member count with compact notation for large numbers.
 * e.g. 1234 -> "1,234", 12345 -> "12.3K"
 */
export function formatMemberCount(count: number): string {
  if (count < 1000) return count.toLocaleString();
  if (count < 1_000_000) return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (count / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}
