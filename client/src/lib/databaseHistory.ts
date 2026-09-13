import { accountScopeKey, type AccountScope } from './serverScope';

export const DATABASE_HISTORY_HEADER = 'X-Paracord-History-Epoch';
const epochs = new Map<string, string | null>();
const operations = new Map<string, Set<() => void>>();
const resets = new Map<string, (scope: AccountScope) => void>();
const listeners = new Set<() => void>();
const reconcilers = new Set<(scope: AccountScope) => void>();
const storageKey = (scope: AccountScope) => `paracord:database-history:${accountScopeKey(scope)}`;

export function isDatabaseHistoryEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** Public, opaque metadata is retained so a reload cannot bypass a known restore. */
export function getDatabaseHistoryEpoch(scope: AccountScope): string | null {
  const key = accountScopeKey(scope);
  if (!epochs.has(key)) {
    const value = localStorage.getItem(storageKey(scope));
    if (value !== null && !isDatabaseHistoryEpoch(value)) throw new Error('The saved database history identity is invalid. Reconnect this account to refresh it.');
    epochs.set(key, value);
  }
  return epochs.get(key)!;
}

export function subscribeDatabaseHistoryOperation(scope: AccountScope, expire: () => void): () => void {
  const key = accountScopeKey(scope);
  const registered = operations.get(key) ?? new Set<() => void>();
  registered.add(expire);
  operations.set(key, registered);
  return () => {
    registered.delete(expire);
    if (registered.size === 0 && operations.get(key) === registered) operations.delete(key);
  };
}

export function registerAccountHistoryReset(name: string, reset: (scope: AccountScope) => void): void {
  resets.set(name, reset);
}

export function subscribeDatabaseHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerHistoryReconciler(reconcile: (scope: AccountScope) => void): () => void {
  reconcilers.add(reconcile);
  return () => reconcilers.delete(reconcile);
}

/** A mismatching reply requests a fresh handshake; it never adopts its epoch. */
export function requestHistoryReconciliation(scope: AccountScope): void {
  for (const reconcile of reconcilers) reconcile(scope);
}

/**
 * Only the currently owned authenticated gateway handshake may call this.
 * Invalidate operations before clearing projections, then allow READY to load
 * the replacement history. Healthy resumes of the same history do nothing.
 */
export function acceptDatabaseHistoryEpoch(scope: AccountScope, epoch: unknown): boolean {
  if (!isDatabaseHistoryEpoch(epoch)) throw new Error('The server supplied an invalid database history identity.');
  const key = accountScopeKey(scope);
  // A valid handshake can repair malformed saved metadata, but ordinary
  // operations cannot silently ignore it or send into an unknown history.
  const previous = epochs.has(key) ? epochs.get(key) : localStorage.getItem(storageKey(scope));
  if (previous === epoch) { epochs.set(key, epoch); return false; }
  localStorage.setItem(storageKey(scope), epoch);
  epochs.set(key, epoch);
  for (const expire of [...operations.get(key) ?? []]) expire();
  for (const reset of resets.values()) reset(scope);
  for (const listener of listeners) listener();
  return true;
}

/** Drop only memoized metadata; persisted account history remains authoritative. */
export function clearDatabaseHistoryMemory(): void { epochs.clear(); }
