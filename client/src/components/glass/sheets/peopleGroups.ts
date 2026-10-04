import type { Role, User } from '../../../types';
import type { PersonStatus } from './PersonRow';

/**
 * How the people sheet orders a server's members (docs/index-spec.md §8.6: here
 * now first, then by role): everyone who is here now (present, or in a voice
 * room) in one section, then the rest under the highest hoisted role each of them
 * holds, and finally those with no hoisted role under "Offline".
 */

export interface PeopleEntry {
  user: User;
  name: string;
  status: PersonStatus;
  detail: string;
  /** The voice room they are in, if any. */
  room: string | null;
  roleIds: readonly string[];
}

export interface PeopleSection {
  /** `here`, `offline`, or a role's id. */
  id: string;
  label: string;
  entries: PeopleEntry[];
}

const byName = (a: PeopleEntry, b: PeopleEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function isHere(entry: PeopleEntry): boolean {
  return entry.status !== 'offline' || entry.room !== null;
}

/** The sections, in order, empty ones left out. `roles` null (not loaded) or with none hoisted is just "Offline". */
export function groupPeople(entries: readonly PeopleEntry[], roles: readonly Role[] | null): PeopleSection[] {
  const sections: PeopleSection[] = [];
  const here = entries.filter(isHere).sort(byName);
  if (here.length > 0) sections.push({ id: 'here', label: 'Here now', entries: here });

  const rest = entries.filter((entry) => !isHere(entry));
  const hoisted = (roles ?? []).filter((role) => role.hoist).sort((a, b) => b.position - a.position);
  const placed = new Set<PeopleEntry>();
  for (const role of hoisted) {
    const members = rest.filter((entry) => !placed.has(entry) && entry.roleIds.some((id) => String(id) === String(role.id)));
    if (members.length === 0) continue;
    members.forEach((entry) => placed.add(entry));
    sections.push({ id: role.id, label: role.name, entries: members.sort(byName) });
  }
  const others = rest.filter((entry) => !placed.has(entry)).sort(byName);
  if (others.length > 0) sections.push({ id: 'offline', label: 'Offline', entries: others });
  return sections;
}

export interface PeoplePage extends PeopleSection {
  /** How many the section has in all (the label's count), not just the ones shown. */
  total: number;
}

/** The first `limit` people across the sections in order: a long roster shows a page at a time. */
export function pageSections(sections: readonly PeopleSection[], limit: number): { shown: PeoplePage[]; hidden: number } {
  const shown: PeoplePage[] = [];
  let remaining = Math.max(0, limit);
  let hidden = 0;
  for (const section of sections) {
    const entries = section.entries.slice(0, remaining);
    remaining -= entries.length;
    hidden += section.entries.length - entries.length;
    if (entries.length > 0) shown.push({ ...section, entries, total: section.entries.length });
  }
  return { shown, hidden };
}
