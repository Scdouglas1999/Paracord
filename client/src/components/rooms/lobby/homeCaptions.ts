/**
 * Every sentence the server home page writes about a server, in one place
 * (docs/server-home-spec.md, "Plain words").
 *
 * Plain words: people are here now; a feed card says who, where and when. Pure
 * functions with the clock passed in, so the tests can pin them.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "10 members · 8 here now" (docs/index-spec.md §4.1). "Here now" is left out when nobody is. */
export function presenceLine(online: number, members: number): string {
  const total = plural(members, 'member');
  return online > 0 ? `${total} · ${online} here now` : total;
}

/** "Priya", "Priya and Ren", "Priya, Ren and 2 others". */
export function namesLine(names: readonly string[], max = 2): string {
  const list = names.filter((name) => name.trim().length > 0);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length <= max) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  const rest = list.length - max;
  return `${list.slice(0, max).join(', ')} and ${plural(rest, 'other')}`;
}

/** "Yara joined", "Yara and Ken joined", "Yara and 2 others joined". */
export function joinedLine(names: readonly string[], total: number): string {
  const first = names[0]?.trim() || 'Someone';
  const others = Math.max(0, total - 1);
  if (others === 0) return `${first} joined`;
  if (others === 1 && names[1]) return `${first} and ${names[1]} joined`;
  return `${first} and ${plural(others, 'other')} joined`;
}

/** "3 replies". */
export function repliesLine(count: number): string {
  return count === 0 ? 'No replies yet' : plural(count, 'reply', 'replies');
}

/**
 * A short stamp for a feed card: "now", "12m", "3h", "yesterday", "Tue",
 * then "14 Sep". The card's header is small; this has to be too.
 */
export function shortAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const diff = nowMs - at;
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  const date = new Date(at);
  const now = new Date(nowMs);
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay || diff < 6 * HOUR) return `${Math.floor(diff / HOUR)}h`;
  if (new Date(nowMs - DAY).toDateString() === date.toDateString()) return 'yesterday';
  if (diff < 6 * DAY) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
