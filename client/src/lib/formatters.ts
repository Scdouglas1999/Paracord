import { formatDistanceToNow } from 'date-fns';

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
 * Formats a timestamp for display next to a message using the browser locale.
 * "Today at 3:45 PM", "Yesterday at 10:00 AM", or "1/15/2025 3:45 PM".
 *
 * Locale-aware toLocaleTimeString/toLocaleDateString output. Shared by the
 * message list and search panel; kept locale-based to preserve their existing
 * rendering.
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
