/**
 * The next thing on the building's calendar (docs/lantern-stage-spec.md §7.3).
 *
 * The Lobby's "Coming up" card and the header's "thermal test at 1 pm" clause
 * are the same fact, so they come from the same place. This reads the scheduled
 * events the server already exposes — `GET /guilds/:id/events`, the endpoint
 * `components/guild/EventList.tsx` has always used — and adds nothing to the
 * wire: no new route, no new store, no new gateway event.
 *
 * Nothing is invented when the list is empty. `event` is simply null and §7.3
 * says the card is omitted entirely — never a placeholder.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getApi } from '../../../api/activeClient';
import { extractApiError } from '../../../api/client';
import { toast } from '../../../stores/toastStore';

/** The scheduled-event fields this surface reads. The server sends more. */
interface ScheduledEventPayload {
  id?: unknown;
  name?: unknown;
  channel_id?: unknown;
  creator_id?: unknown;
  scheduled_start?: unknown;
  location?: unknown;
  status?: unknown;
  user_count?: unknown;
  user_rsvp?: unknown;
}

/** One event, normalised — every field already checked, nothing optional. */
export interface LobbyEvent {
  id: string;
  name: string;
  /** Parsed and finite: an unparseable start is dropped, never rendered raw. */
  startsAt: Date;
  channelId: string | null;
  location: string | null;
  creatorId: string | null;
  going: number;
  youAreGoing: boolean;
}

/** 1 = scheduled, 2 = active. 3 and 4 are over and cannot be "coming up". */
const UPCOMING_STATUS = new Set([1, 2]);

/** The gateway collapses every scheduled-event change into this DOM event. */
const CHANGED_EVENT = 'paracord:scheduled-events-changed';

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * One wire event → one {@link LobbyEvent}, or null.
 *
 * Exported because the rule "what counts as coming up" is worth pinning in a
 * test: a cancelled event, an event that has already started and finished, or
 * one whose start we cannot parse is not something to put in front of a human.
 */
export function toLobbyEvent(raw: unknown, nowMs: number): LobbyEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as ScheduledEventPayload;
  const id = toText(payload.id);
  const name = toText(payload.name);
  if (!id || !name) return null;
  const status = typeof payload.status === 'number' ? payload.status : 1;
  if (!UPCOMING_STATUS.has(status)) return null;
  const start = toText(payload.scheduled_start);
  if (!start) return null;
  const startsAt = new Date(start);
  if (!Number.isFinite(startsAt.getTime())) return null;
  // An event that is already running (status 2) still counts as "coming up";
  // one that started long ago and was never closed out does not.
  if (status === 1 && startsAt.getTime() < nowMs) return null;
  return {
    id,
    name,
    startsAt,
    channelId: toText(payload.channel_id),
    location: toText(payload.location),
    creatorId: toText(payload.creator_id),
    going: typeof payload.user_count === 'number' && payload.user_count > 0 ? payload.user_count : 0,
    youAreGoing: payload.user_rsvp === true,
  };
}

/** The soonest event that is still coming up, or null. */
export function nextEventOf(raw: unknown, nowMs: number): LobbyEvent | null {
  if (!Array.isArray(raw)) return null;
  const upcoming = raw
    .map((entry) => toLobbyEvent(entry, nowMs))
    .filter((entry): entry is LobbyEvent => entry !== null)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return upcoming[0] ?? null;
}

export interface NextEvent {
  event: LobbyEvent | null;
  /** Toggle the local account's RSVP. Resolves once the server has agreed. */
  toggleRsvp: () => Promise<void>;
}

export function useNextEvent(guildId: string | null | undefined): NextEvent {
  const [event, setEvent] = useState<LobbyEvent | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!guildId) return;
      try {
        const response = await getApi().get(`/guilds/${guildId}/events`, { signal });
        if (signal.aborted) return;
        setEvent(nextEventOf(response.data, Date.now()));
      } catch {
        // A building whose calendar we cannot read simply has no "Coming up"
        // card. There is nothing for a human to do about it here, so this is
        // not a toast — the surface just stays quiet (§7.3: omitted, never a
        // placeholder).
        if (!signal.aborted) setEvent(null);
      }
    },
    [guildId],
  );

  useEffect(() => {
    if (!guildId) {
      setEvent(null);
      return;
    }
    const controller = new AbortController();
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

  const toggleRsvp = useCallback(async () => {
    if (!guildId || !event) return;
    const going = event.youAreGoing;
    try {
      const api = getApi();
      const path = `/guilds/${guildId}/events/${event.id}/rsvp`;
      if (going) await api.delete(path);
      else await api.put(path);
      setEvent((current) =>
        current && current.id === event.id
          ? {
              ...current,
              youAreGoing: !going,
              going: Math.max(0, current.going + (going ? -1 : 1)),
            }
          : current,
      );
    } catch (err) {
      const detail = extractApiError(err);
      toast.error(detail ? `Failed to update RSVP: ${detail}` : 'Failed to update RSVP');
    }
  }, [guildId, event]);

  return useMemo(() => ({ event, toggleRsvp }), [event, toggleRsvp]);
}
