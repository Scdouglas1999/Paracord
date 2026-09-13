/**
 * When a room lit up, and when it last went dark
 * (docs/lantern-stage-spec.md §7.3 "last lit 2 h ago", §7.2 call duration).
 *
 * Neither number is on the wire: the gateway sends voice membership, not call
 * start times, and it does not tell a client when a room emptied while the app
 * was closed. Rather than invent a server field in WP1, the client remembers
 * what it has **observed itself**, and says so.
 *
 * The honesty rules this encodes:
 *   - `litSinceMs` is "since this client first saw the room lit", so a duration
 *     reads from when *we* started watching, never from a guessed start. A room
 *     already running when the app opens shows time-we-have-seen-it, which is a
 *     lower bound, never an over-claim.
 *   - `lastLitMs` is null until this client has actually seen the room lit, so
 *     an unseen room reads "never lit", not a fabricated hour.
 *
 * Pure and injectable — NO store, React or DOM imports, no ambient clock.
 */

export interface RoomLitTimes {
  /** When this client first saw the room lit in its current run, or null. */
  litSinceMs: number | null;
  /** When this client last saw the room lit, or null if it never has. */
  lastLitMs: number | null;
}

export interface LitHistory {
  /** Record what a room looks like now and read back its times. */
  observe: (key: string, lit: boolean, nowMs: number) => RoomLitTimes;
  /** Read without recording — for a room this tick did not visit. */
  peek: (key: string) => RoomLitTimes;
  /** Forget everything. Called on logout, with the rest of the session. */
  clear: () => void;
  /** How many rooms are remembered (tests + the eviction guard). */
  readonly size: number;
}

/**
 * Rooms are remembered for as long as they are interesting. The cap stops a
 * long session on a large instance from growing this map without bound; the
 * oldest-seen entry goes first, and losing it only costs a "last lit" label.
 */
export const LIT_HISTORY_MAX_ROOMS = 2_000;

interface Entry {
  litSinceMs: number | null;
  lastLitMs: number | null;
  touchedMs: number;
}

export function createLitHistory(max = LIT_HISTORY_MAX_ROOMS): LitHistory {
  const entries = new Map<string, Entry>();

  function evictIfNeeded() {
    if (entries.size <= max) return;
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of entries) {
      if (entry.touchedMs < oldestAt) {
        oldestAt = entry.touchedMs;
        oldestKey = key;
      }
    }
    if (oldestKey != null) entries.delete(oldestKey);
  }

  return {
    observe(key, lit, nowMs) {
      const existing = entries.get(key);
      const entry: Entry = existing ?? { litSinceMs: null, lastLitMs: null, touchedMs: nowMs };
      if (lit) {
        // A room that was already lit keeps its original start — that is the
        // whole point of the record.
        if (entry.litSinceMs == null) entry.litSinceMs = nowMs;
        entry.lastLitMs = nowMs;
      } else {
        entry.litSinceMs = null;
      }
      entry.touchedMs = nowMs;
      entries.set(key, entry);
      evictIfNeeded();
      return { litSinceMs: entry.litSinceMs, lastLitMs: entry.lastLitMs };
    },
    peek(key) {
      const entry = entries.get(key);
      return { litSinceMs: entry?.litSinceMs ?? null, lastLitMs: entry?.lastLitMs ?? null };
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * The process-wide history the light selectors share. One instance so the
 * sidebar, the Lobby and Home all agree about when a room lit up.
 */
export const roomLitHistory = createLitHistory();
