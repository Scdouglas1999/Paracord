import type { SearchChip } from './query';

/**
 * Recent searches, kept on this device only. Each server (and each direct
 * conversation) has its own list, because a chip names a member or channel id
 * that means nothing anywhere else.
 */
const STORAGE_PREFIX = 'paracord:recent-searches:';
const LIMIT = 8;
const UNREADABLE = 'Recent searches saved on this device could not be read.';

export interface RecentSearch {
  id: string;
  label: string;
  text: string;
  chips: SearchChip[];
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

function isChip(value: unknown): value is SearchChip {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'from' || kind === 'in' || kind === 'has' || kind === 'mentions'
    || kind === 'before' || kind === 'after' || kind === 'during' || kind === 'pinned';
}

function isRecent(value: unknown): value is RecentSearch {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<RecentSearch>;
  return typeof entry.id === 'string'
    && typeof entry.label === 'string'
    && typeof entry.text === 'string'
    && Array.isArray(entry.chips)
    && entry.chips.every(isChip);
}

/** Throws with a message fit for the UI when the saved list is corrupt. */
export function readRecentSearches(scope: string): RecentSearch[] {
  const raw = localStorage.getItem(storageKey(scope));
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(UNREADABLE);
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecent)) {
    throw new Error(UNREADABLE);
  }
  return parsed.slice(0, LIMIT);
}

function write(scope: string, entries: RecentSearch[]): void {
  localStorage.setItem(storageKey(scope), JSON.stringify(entries));
}

export function rememberSearch(scope: string, entry: Omit<RecentSearch, 'id'>): RecentSearch[] {
  const label = entry.label.trim();
  if (!label) return readRecentSearches(scope);
  const current = readRecentSearches(scope).filter((item) => item.label !== label);
  const next = [{ ...entry, label, id: `${Date.now()}-${label}` }, ...current].slice(0, LIMIT);
  write(scope, next);
  return next;
}

export function forgetSearch(scope: string, id: string): RecentSearch[] {
  const next = readRecentSearches(scope).filter((item) => item.id !== id);
  write(scope, next);
  return next;
}

/** Clears a corrupt list so the next search can be saved. */
export function clearRecentSearches(scope: string): void {
  localStorage.removeItem(storageKey(scope));
}
