/** How far the board will look, in either direction. Matches the server window. */
export const BOARD_DATE_WINDOW = 14;

const DAY_MS = 86_400_000;

export interface BoardDay {
  /** Local calendar day, YYYY-MM-DD. This is the deep-link value. */
  iso: string;
  /** YYYYMMDD, the board query. */
  compact: string;
  /** 0 is today, -1 yesterday, 1 tomorrow. */
  offset: number;
  /** "Today", "Yesterday", "Tomorrow", or "Sat, Sep 20". */
  label: string;
}

export function localIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function compactDate(iso: string): string {
  return iso.replace(/-/g, '');
}

function parseIso(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (localIso(date) !== iso) return null;
  return date;
}

function dayLabel(offset: number, date: Date): string {
  if (offset === 0) return 'Today';
  if (offset === -1) return 'Yesterday';
  if (offset === 1) return 'Tomorrow';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function boardDay(offset: number, now = new Date()): BoardDay {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const iso = localIso(date);
  return { iso, compact: compactDate(iso), offset, label: dayLabel(offset, date) };
}

/** A missing, invalid, or out-of-window param is today. */
export function boardDayFromParam(param: string | null | undefined, now = new Date()): BoardDay {
  if (!param) return boardDay(0, now);
  const date = parseIso(param);
  if (!date) return boardDay(0, now);
  const today = parseIso(localIso(now));
  if (!today) return boardDay(0, now);
  const offset = Math.round((date.getTime() - today.getTime()) / DAY_MS);
  if (offset < -BOARD_DATE_WINDOW || offset > BOARD_DATE_WINDOW) return boardDay(0, now);
  return boardDay(offset, now);
}

export function sportsTitle(day: BoardDay): string {
  return day.offset === 0 ? 'Sports' : `Sports · ${day.label}`;
}

/** The day as it reads in a sentence: "today", "yesterday", "on Sat, Sep 20". */
export function emptyDayPhrase(day: BoardDay): string {
  if (day.offset === 0) return 'today';
  if (day.offset === -1) return 'yesterday';
  if (day.offset === 1) return 'tomorrow';
  return `on ${day.label}`;
}
