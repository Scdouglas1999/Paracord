/**
 * A server's calendar, for its home page: what is happening now and the next
 * few things coming up (docs/server-home-spec.md, "Live now" and "Coming up").
 *
 * It reads the scheduled events the server already exposes —
 * `GET /guilds/:id/events`, the endpoint `components/guild/EventList.tsx` uses —
 * and RSVPs through the same `PUT`/`DELETE …/rsvp` pair.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getApi } from '../../../api/activeClient';
import { extractApiError } from '../../../api/client';
import { toast } from '../../../stores/toastStore';

interface ScheduledEventPayload {
  id?: unknown;
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

/** One event, normalised: every field checked, nothing left to parse. */
export interface HomeEvent {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date | null;
  channelId: string | null;
  location: string | null;
  creatorId: string | null;
  going: number;
  youAreGoing: boolean;
  /** Running right now: marked active, or started and not yet over. */
  happeningNow: boolean;
}

/** 1 = scheduled, 2 = active. 3 (done) and 4 (cancelled) are never shown. */
const SCHEDULED = 1;
const ACTIVE = 2;

/** An event with no end counts as "now" for this long after its start. */
export const NOW_WINDOW_MS = 2 * 60 * 60 * 1000;

const CHANGED_EVENT = 'paracord:scheduled-events-changed';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function date(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** One wire event → a {@link HomeEvent}, or null when it is not upcoming or live. */
export function toHomeEvent(raw: unknown, nowMs: number): HomeEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as ScheduledEventPayload;
  const id = text(payload.id);
  const name = text(payload.name);
  const startsAt = date(payload.scheduled_start);
  if (!id || !name || !startsAt) return null;
  const status = typeof payload.status === 'number' ? payload.status : SCHEDULED;
  if (status !== SCHEDULED && status !== ACTIVE) return null;
  const endsAt = date(payload.scheduled_end);
  const start = startsAt.getTime();
  const end = endsAt ? endsAt.getTime() : start + NOW_WINDOW_MS;
  const started = start <= nowMs;
  if (started && end < nowMs && status !== ACTIVE) return null;
  return {
    id,
    name,
    startsAt,
    endsAt,
    channelId: text(payload.channel_id),
    location: text(payload.location),
    creatorId: text(payload.creator_id),
    going: typeof payload.user_count === 'number' && payload.user_count > 0 ? payload.user_count : 0,
    youAreGoing: payload.user_rsvp === true,
    happeningNow: status === ACTIVE || (started && end >= nowMs),
  };
}

/** Everything upcoming or live, soonest first. */
export function upcomingEvents(raw: unknown, nowMs: number): HomeEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => toHomeEvent(entry, nowMs))
    .filter((entry): entry is HomeEvent => entry !== null)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export interface UpcomingEvents {
  events: HomeEvent[];
  /** The calendar could not be read. Shown in the widget, never swallowed. */
  error: string | null;
  loaded: boolean;
  toggleRsvp: (eventId: string) => Promise<void>;
}

export function useUpcomingEvents(guildId: string): UpcomingEvents {
  const [events, setEvents] = useState<HomeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await getApi().get(`/guilds/${guildId}/events`, { signal });
        if (signal.aborted) return;
        setEvents(upcomingEvents(response.data, Date.now()));
        setError(null);
      } catch (err) {
        if (signal.aborted) return;
        setError(extractApiError(err));
      } finally {
        if (!signal.aborted) setLoaded(true);
      }
    },
    [guildId],
  );

  useEffect(() => {
    if (!guildId) return;
    const controller = new AbortController();
    setLoaded(false);
    void load(controller.signal);
    const onChanged = (raw: Event) => {
      const detail = (raw as CustomEvent<{ guild_id?: string }>).detail;
      if (detail?.guild_id && detail.guild_id !== guildId) return;
      void load(controller.signal);
    };
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => {
      controller.abort();
      window.removeEventListener(CHANGED_EVENT, onChanged);
    };
  }, [guildId, load]);

  const toggleRsvp = useCallback(
    async (eventId: string) => {
      const event = events.find((entry) => entry.id === eventId);
      if (!event) return;
      const going = event.youAreGoing;
      try {
        const path = `/guilds/${guildId}/events/${eventId}/rsvp`;
        if (going) await getApi().delete(path);
        else await getApi().put(path);
        setEvents((current) =>
          current.map((entry) =>
            entry.id === eventId
              ? { ...entry, youAreGoing: !going, going: Math.max(0, entry.going + (going ? -1 : 1)) }
              : entry,
          ),
        );
      } catch (err) {
        toast.error(`Could not update your RSVP: ${extractApiError(err)}`);
      }
    },
    [guildId, events],
  );

  return useMemo(() => ({ events, error, loaded, toggleRsvp }), [events, error, loaded, toggleRsvp]);
}
