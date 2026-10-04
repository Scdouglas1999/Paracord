import { placeOfPath, serverPlace } from '../shell/place';
import { useIxPlaceStore } from '../shell/usePlace';

/**
 * Where you were (docs/index-spec.md §8.1): `/app` and `/app/dms` are not pages.
 * Home is retired, so `/app` opens the last place (the last server channel, or the
 * last People item) and `/app/dms` the last People item.
 *
 * What is remembered, across launches, in this browser's storage:
 *
 *   place    `people`, or the id of the server you were in
 *   path     the route you were on in that server (a channel), or null
 *   people   the route you were on in People (a conversation, Friends or Inbox)
 *
 * It is a convenience, never a source of truth: storage may be blocked, cleared or
 * from another account, and the server may be gone by the time it is read. Every
 * read is validated (the shape, the user, a route that can be restored) and
 * `resolveLastPlace` checks the rest against what the client knows now.
 */

export interface PlaceMemory {
  /** The account the memory is for; another account's is ignored. */
  userId: string;
  place: string;
  path: string | null;
  people: string | null;
}

export const PLACE_MEMORY_KEY = 'paracord:ix-last-place';

/** Routes that can be restored: a channel, a conversation, Friends, Inbox. Never `/app` or a bare `/app/dms` (a loop). */
const SERVER_ROUTE = /^\/app\/guilds\/([^/?#]+)\/channels\/[^/?#]+$/;
const PEOPLE_ROUTE = /^\/app\/(dms\/[^/?#]+|friends|inbox)$/;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The stored memory, or null when there is none or it does not make sense. */
export function readPlaceMemory(storage: Pick<Storage, 'getItem'> | null = safeStorage()): PlaceMemory | null {
  try {
    const raw = storage?.getItem(PLACE_MEMORY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const userId = stringOrNull(record.userId);
    const place = stringOrNull(record.place);
    if (!userId || !place) return null;
    const path = stringOrNull(record.path);
    const people = stringOrNull(record.people);
    return {
      userId,
      place,
      path: path && place !== 'people' && SERVER_ROUTE.exec(path)?.[1] === place ? path : null,
      people: people && PEOPLE_ROUTE.test(people) ? people : null,
    };
  } catch {
    return null;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function writePlaceMemory(memory: PlaceMemory, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(PLACE_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Blocked or full storage only means the next launch does not reopen where you were.
  }
}

/**
 * What a route says about where you are: the place it belongs to and, when it is
 * something that can be reopened, its path. Null for a route that is neither (a
 * server's Overview or Events keeps the place but not a path; admin, settings,
 * Discover and the redirects say nothing).
 */
export function memoryOfRoute(pathname: string, guildIds: ReadonlySet<string>): { place: string; path?: string; people?: string } | null {
  const place = placeOfPath(pathname);
  if (!place) return null;
  if (place.kind === 'server') {
    if (!guildIds.has(place.guildId)) return null;
    return SERVER_ROUTE.test(pathname) ? { place: place.guildId, path: pathname } : { place: place.guildId };
  }
  return PEOPLE_ROUTE.test(pathname) ? { place: 'people', people: pathname } : null;
}

/** Remember the route you are on. Cheap and idempotent: it writes only when something changed. */
export function rememberRoute(pathname: string, userId: string, guildIds: ReadonlySet<string>): void {
  const seen = memoryOfRoute(pathname, guildIds);
  if (!seen) return;
  const before = readPlaceMemory();
  const mine = before && before.userId === userId ? before : null;
  const next: PlaceMemory = {
    userId,
    place: seen.place,
    // A server keeps the route you left it on until you open another channel there; another server starts over.
    path: seen.path ?? (mine && mine.place === seen.place ? mine.path : null),
    people: seen.people ?? mine?.people ?? null,
  };
  if (mine && mine.place === next.place && mine.path === next.path && mine.people === next.people) return;
  writePlaceMemory(next);
}

/**
 * Put the sidebar on the place you were in before the first paint of a launch, so
 * a launch at `/app` does not show People for a frame and then slide to your
 * server. `/app` belongs to no place, so the shell shows the last one it knows.
 */
export function restoreLastPlace(): void {
  const memory = readPlaceMemory();
  if (!memory || memory.place === 'people') return;
  useIxPlaceStore.setState({ last: serverPlace(memory.place) });
}

restoreLastPlace();

/* ---- Where `/app` and `/app/dms` go ------------------------------------------------ */

export type Resolution =
  /** Something the answer needs has not arrived yet: say nothing, navigate nowhere. */
  | { kind: 'wait' }
  | { kind: 'go'; path: string }
  /** A server with no remembered channel: open its landing channel. */
  | { kind: 'landing'; guildId: string };

export interface ResolveInput {
  /** `app` for `/app` (the last place), `dms` for `/app/dms` (the last People item). */
  mode: 'app' | 'dms';
  /** The memory for THIS account, or null. */
  memory: PlaceMemory | null;
  /** The servers you are in, in dock order. */
  guildIds: readonly string[];
  /** The conversations you are in, the one with the newest message first. */
  dmIds: readonly string[];
  /** The servers and conversations have been asked for, and have answered (or failed). */
  settled: boolean;
}

function peopleTarget({ memory, dmIds, settled }: ResolveInput): Resolution {
  const remembered = memory?.people ?? null;
  if (remembered) {
    if (!remembered.startsWith('/app/dms/')) return { kind: 'go', path: remembered };
    // A conversation you were in may be gone (you left the group); only the list knows.
    if (dmIds.includes(remembered.slice('/app/dms/'.length))) return { kind: 'go', path: remembered };
    if (!settled) return { kind: 'wait' };
  }
  if (dmIds.length > 0) return { kind: 'go', path: `/app/dms/${dmIds[0]}` };
  if (!settled) return { kind: 'wait' };
  return { kind: 'go', path: '/app/friends' };
}

/**
 * Where `/app` and `/app/dms` should go. Pure, so the rule is a unit test:
 *
 *   `/app`      the remembered server (its channel, else its landing channel) while
 *               you are still in it; the remembered People item otherwise. With no
 *               memory, your first server, else People.
 *   `/app/dms`  the remembered People item while it still exists, else your most
 *               recent conversation, else Friends (§8.1).
 *
 * A server that is not in the list yet is waited for until the list has answered;
 * only then is it gone (you left it) and People opens instead.
 */
export function resolveLastPlace(input: ResolveInput): Resolution {
  const { mode, memory, guildIds, settled } = input;
  if (mode === 'app') {
    if (memory && memory.place !== 'people') {
      if (guildIds.includes(memory.place)) {
        return memory.path ? { kind: 'go', path: memory.path } : { kind: 'landing', guildId: memory.place };
      }
      if (!settled) return { kind: 'wait' };
    } else if (!memory) {
      if (guildIds.length > 0) return { kind: 'landing', guildId: guildIds[0] };
      if (!settled) return { kind: 'wait' };
    }
  }
  return peopleTarget(input);
}
