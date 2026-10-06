import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

import { getApi } from '../../../api/activeClient';
import { extractApiError } from '../../../api/client';
import { useServerReady } from '../../../hooks/useServerReady';
import { LOCAL_SERVER_ID } from '../../../lib/serverScope';
import { registerSessionReset } from '../../../stores/sessionReset';
import { useServerListStore } from '../../../stores/serverListStore';
import { toast } from '../../../stores/toastStore';

/**
 * One scheduled event, by id, for the plan card and the inline event chip
 * (docs/glass-spec.md §3.2).
 *
 * A message that mentions an event carries only its id (`<event:7001>`), so the
 * card asks the server for it: `GET /guilds/:g/events/:e`, the endpoint the
 * settings list is built on, and RSVPs with the same `PUT`/`DELETE …/rsvp` pair
 * (`components/rooms/lobby/useUpcomingEvents.ts`). One request per event no
 * matter how many chips name it, kept current by the gateway's
 * `paracord:scheduled-events-changed` window event.
 *
 * WHAT IT DOES NOT HAVE. The server tells a card how many are going and whether
 * you are, not who. So the card can show the host and you; it cannot show every
 * face, and it does not pretend to.
 */

interface WireEvent {
  id?: unknown;
  guild_id?: unknown;
  name?: unknown;
  channel_id?: unknown;
  creator_id?: unknown;
  scheduled_start?: unknown;
  scheduled_end?: unknown;
  location?: unknown;
  status?: unknown;
  user_count?: unknown;
  user_rsvp?: unknown;
}

export interface GuildEventView {
  id: string;
  guildId: string;
  name: string;
  startsAt: Date;
  endsAt: Date | null;
  channelId: string | null;
  location: string | null;
  creatorId: string | null;
  going: number;
  youAreGoing: boolean;
  /** 1 scheduled, 2 active, 3 completed, 4 canceled. */
  status: number;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const date = (value: unknown): Date | null => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

/** One wire event as a view, or null when it is not an event at all. */
export function toEventView(raw: unknown, guildId: string): GuildEventView | null {
  if (!raw || typeof raw !== 'object') return null;
  const wire = raw as WireEvent;
  const id = text(wire.id);
  const name = text(wire.name);
  const startsAt = date(wire.scheduled_start);
  if (!id || !name || !startsAt) return null;
  return {
    id,
    guildId: text(wire.guild_id) ?? guildId,
    name,
    startsAt,
    endsAt: date(wire.scheduled_end),
    channelId: text(wire.channel_id),
    location: text(wire.location),
    creatorId: text(wire.creator_id),
    going: typeof wire.user_count === 'number' && wire.user_count > 0 ? wire.user_count : 0,
    youAreGoing: wire.user_rsvp === true,
    status: typeof wire.status === 'number' ? wire.status : 1,
  };
}

/** Running right now: marked active, or started and not yet over (an event with no end runs two hours). */
export function isHappeningNow(event: GuildEventView, nowMs: number): boolean {
  if (event.status === 3 || event.status === 4) return false;
  if (event.status === 2) return true;
  const start = event.startsAt.getTime();
  const end = event.endsAt ? event.endsAt.getTime() : start + 2 * 60 * 60 * 1000;
  return start <= nowMs && end >= nowMs;
}

export type GuildEventStatus = 'loading' | 'ready' | 'missing' | 'error';

interface Entry {
  status: GuildEventStatus;
  event: GuildEventView | null;
  error: string | null;
  /** A vote to go (or not) is on its way. */
  busy: boolean;
}

interface GuildEventStore {
  entries: Record<string, Entry>;
  set: (key: string, entry: Entry) => void;
  reset: () => void;
}

const useGuildEventStore = create<GuildEventStore>()((set) => ({
  entries: {},
  set: (key, entry) => set((state) => ({ entries: { ...state.entries, [key]: entry } })),
  reset: () => set({ entries: {} }),
}));
const inflight = new Map<string, Promise<void>>();
registerSessionReset('glass-guild-events', () => {
  inflight.clear();
  useGuildEventStore.getState().reset();
});

const CHANGED_EVENT = 'paracord:scheduled-events-changed';
const NONE: Entry = { status: 'loading', event: null, error: null, busy: false };

function serverKey(): string {
  return useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID;
}

const keyOf = (server: string, guildId: string, eventId: string) => `${server}\u0000${guildId}\u0000${eventId}`;

async function load(key: string, guildId: string, eventId: string): Promise<void> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = (async () => {
    const store = useGuildEventStore.getState();
    const previous = store.entries[key];
    try {
      const response = await getApi().get(`/guilds/${encodeURIComponent(guildId)}/events/${encodeURIComponent(eventId)}`);
      const event = toEventView(response.data, guildId);
      store.set(key, event
        ? { status: 'ready', event, error: null, busy: false }
        : { status: 'missing', event: null, error: null, busy: false });
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      // A missing or forbidden event is a fact about the event; anything else
      // is a failure to ask, which a reader may retry by scrolling back.
      store.set(key, status === 404 || status === 403
        ? { status: 'missing', event: null, error: null, busy: false }
        : { status: 'error', event: previous?.event ?? null, error: extractApiError(error), busy: false });
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

let listening = false;
function listenForChanges(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(CHANGED_EVENT, (raw) => {
    const changed = (raw as CustomEvent<{ guild_id?: string }>).detail?.guild_id;
    for (const key of Object.keys(useGuildEventStore.getState().entries)) {
      const [server, guildId, eventId] = key.split('\u0000');
      if (server !== serverKey() || (changed && changed !== guildId)) continue;
      void load(key, guildId, eventId);
    }
  });
}

export interface GuildEventResult {
  status: GuildEventStatus;
  event: GuildEventView | null;
  error: string | null;
  busy: boolean;
  /** Take the spot, or give it back. */
  toggleRsvp: () => Promise<void>;
}

/** The event `eventId` in `guildId`, loaded once and shared by everything that names it. */
export function useGuildEvent(guildId: string | null | undefined, eventId: string): GuildEventResult {
  const server = serverKey();
  const key = guildId ? keyOf(server, guildId, eventId) : null;
  const entry = useGuildEventStore((state) => (key ? state.entries[key] : undefined)) ?? NONE;
  // The event is the selected server's: it is asked for once that server is connected,
  // and until then the row stays in its loading state rather than showing an error.
  const ready = useServerReady();

  useEffect(() => {
    if (!key || !guildId || !ready) return;
    listenForChanges();
    // A failed ask is asked again the next time the row is drawn.
    const known = useGuildEventStore.getState().entries[key];
    if (!known || known.status === 'error') void load(key, guildId, eventId);
  }, [key, guildId, eventId, ready]);

  const toggleRsvp = useCallback(async () => {
    if (!key || !guildId) return;
    const store = useGuildEventStore.getState();
    const current = store.entries[key];
    if (!current?.event || current.busy) return;
    const going = current.event.youAreGoing;
    store.set(key, { ...current, busy: true });
    try {
      const path = `/guilds/${encodeURIComponent(guildId)}/events/${encodeURIComponent(eventId)}/rsvp`;
      if (going) await getApi().delete(path);
      else await getApi().put(path);
      const latest = useGuildEventStore.getState().entries[key] ?? current;
      const event = latest.event ?? current.event;
      store.set(key, {
        ...latest,
        busy: false,
        event: { ...event, youAreGoing: !going, going: Math.max(0, event.going + (going ? -1 : 1)) },
      });
    } catch (error) {
      const latest = useGuildEventStore.getState().entries[key] ?? current;
      store.set(key, { ...latest, busy: false });
      toast.error(`Could not update your RSVP: ${extractApiError(error)}`);
    }
  }, [key, guildId, eventId]);

  return { status: entry.status, event: entry.event, error: entry.error, busy: entry.busy, toggleRsvp };
}

/** Test seam: forget everything the events cache holds. */
export function resetGuildEventsForTests(): void {
  inflight.clear();
  useGuildEventStore.getState().reset();
}
