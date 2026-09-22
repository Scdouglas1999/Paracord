export interface MonthGroup<T> {
  label: string;
  items: T[];
}

/** Group already-newest-first items under "September 2026" headers, in that order. */
export function groupByMonth<T extends { created_at: string }>(
  items: readonly T[],
  locale = 'en-US',
): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = [];
  for (const item of items) {
    const date = new Date(item.created_at);
    const label = Number.isNaN(date.getTime())
      ? 'Unknown date'
      : date.toLocaleString(locale, { month: 'long', year: 'numeric' });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export function authorLabel(author: { display_name?: string | null; username: string }): string {
  const name = author.display_name?.trim();
  return name || author.username;
}
