/**
 * Native tooltip for a reaction chip: "Jonas, Lena and 2 others reacted with 🌙".
 * `names` are the first people in reaction order; `total` is everyone.
 */
export function reactionTitle(names: readonly string[], total: number, emoji: string): string {
  const shown = names.filter((name) => name.trim().length > 0).slice(0, 2);
  const count = Math.max(total, shown.length);
  const rest = count - shown.length;
  let who: string;
  if (shown.length === 0) {
    who = count === 1 ? '1 person' : `${count} people`;
  } else if (rest === 0) {
    who = shown.join(' and ');
  } else {
    who = `${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
  }
  return `${who} reacted with ${emoji}`;
}
