/**
 * The quick switcher's ordering and filtering (docs/index-spec.md §4.2, §6.3),
 * kept out of the component so what comes first is a unit test.
 *
 * Scoped to the current server first: its channels, then its rooms, then its
 * people, and only then the other servers and direct messages. Channels of other
 * servers follow (found only by typing), and the commands (New message, Add a
 * friend, Settings, ...) come after every place, only when what is typed matches
 * them. The "Search messages in <server>" row is not in this list: it is always
 * the last row of the switcher.
 */

export type SwitcherCategory =
  | 'channels'
  | 'rooms'
  | 'people'
  | 'servers'
  | 'dms'
  | 'elsewhere'
  | 'commands';

/** The order the groups appear in. */
export const SWITCHER_ORDER: readonly SwitcherCategory[] = [
  'channels',
  'rooms',
  'people',
  'servers',
  'dms',
  'elsewhere',
  'commands',
];

export const SWITCHER_LABEL: Record<SwitcherCategory, string> = {
  channels: 'Channels',
  rooms: 'Voice channels',
  people: 'People',
  servers: 'Servers',
  dms: 'Direct messages',
  elsewhere: 'In other servers',
  commands: 'Commands',
};

/** How many of each group show: more when nothing is typed for the places a person goes to most, fewer once they type. */
const CAP_EMPTY: Record<SwitcherCategory, number> = {
  channels: 10,
  rooms: 6,
  people: 0,
  servers: 6,
  dms: 5,
  elsewhere: 0,
  commands: 0,
};

const CAP_TYPED: Record<SwitcherCategory, number> = {
  channels: 8,
  rooms: 5,
  people: 6,
  servers: 5,
  dms: 5,
  elsewhere: 5,
  commands: 6,
};

export interface SwitcherCandidate {
  id: string;
  category: SwitcherCategory;
  label: string;
  sublabel?: string;
  keywords?: string;
}

export interface SwitcherGroup<T extends SwitcherCandidate> {
  category: SwitcherCategory;
  label: string;
  items: T[];
}

/** 0: the label starts with the query; 1: a word in it does; 2: it is somewhere in the text. -1: no match. */
export function matchRank(candidate: SwitcherCandidate, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = candidate.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.split(/[\s\-_/]+/).some((word) => word.startsWith(q))) return 1;
  const haystack = `${label} ${(candidate.sublabel ?? '').toLowerCase()} ${(candidate.keywords ?? '').toLowerCase()}`;
  return haystack.includes(q) ? 2 : -1;
}

/** Filter, rank within each group, cap and order the groups. Empty groups are left out. */
export function arrangeSwitcher<T extends SwitcherCandidate>(candidates: readonly T[], query: string): SwitcherGroup<T>[] {
  const typed = query.trim().length > 0;
  const caps = typed ? CAP_TYPED : CAP_EMPTY;
  const groups: SwitcherGroup<T>[] = [];
  for (const category of SWITCHER_ORDER) {
    const ranked = candidates
      .filter((candidate) => candidate.category === category)
      .map((candidate, index) => ({ candidate, index, rank: matchRank(candidate, query) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, caps[category])
      .map((entry) => entry.candidate);
    if (ranked.length > 0) groups.push({ category, label: SWITCHER_LABEL[category], items: ranked });
  }
  return groups;
}

/** The label of the last row: "Search messages in Fuel for “run”". */
export function searchRowLabel(scopeName: string | null, query: string): string {
  const where = scopeName ? `in ${scopeName}` : 'in this conversation';
  const q = query.trim();
  return q ? `Search messages ${where} for “${q}”` : `Search messages ${where}`;
}
