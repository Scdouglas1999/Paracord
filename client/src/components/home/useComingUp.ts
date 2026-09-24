/**
 * Coming up — the scheduled events across every building (docs/lantern-stage-spec.md §7.5).
 *
 * This reads the scheduled events that already exist (`GET /guilds/:id/events`,
 * the same feed `components/guild/EventList.tsx` renders inside a building) and
 * merges them into one list ordered by when they start. **No new endpoint, no
 * new state on the server** — Home is a different view of the same data.
 *
 * A building whose events cannot be fetched contributes nothing rather than an
 * error banner: the section makes no claim of completeness, and one unreachable
 * server must not blank the events of the others.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { extractApiError } from '../../api/client';
import { captureScopedOperation } from '../../lib/operationContext';
import type { AccountScope } from '../../lib/serverScope';
import type { BuildingLight } from '../../lib/attention/light';
import { toast } from '../../stores/toastStore';

/** Events at most this far into the past still count as "now" rather than over. */
const ACTIVE_GRACE_MS = 3 * 60 * 60 * 1000;

/** Home shows the next few; the building's own event list is the full one. */
export const COMING_UP_CAP = 3;

/** `status`: 1 = scheduled, 2 = active, 3 = completed, 4 = canceled. */
const SCHEDULED = 1;
const ACTIVE = 2;

/** The changed-event signal `EventList` already dispatches when an RSVP lands. */
const EVENTS_CHANGED = 'paracord:scheduled-events-changed';

/** Only the fields Home reads off a scheduled event. */
interface ScheduledEventPayload {
  id: string;
  name: string;
  channel_id: string | null;
  scheduled_start: string;
  status: number;
  location: string | null;
  user_count: number;
  user_rsvp: boolean;
}

interface FetchedEvent extends ScheduledEventPayload {
  /** The building it belongs to, as `entityScopeKey(scope, guildId)`. */
  buildingKey: string;
}

export interface ComingUpEvent {
  key: string;
  buildingKey: string;
  scope: AccountScope;
  guildId: string;
  buildingName: string;
  id: string;
  name: string;
  startsAtMs: number;
  /** The room it happens in, when it is bound to one. */
  roomName: string | null;
  /** An external location, when it is not in a room. */
  location: string | null;
  going: number;
  rsvp: boolean;
}

interface Target {
  buildingKey: string;
  scope: AccountScope;
  guildId: string;
}

export interface ComingUp {
  events: ComingUpEvent[];
  /** Toggle the local account's RSVP. One action per card (§8 EventCard). */
  setGoing: (event: ComingUpEvent, going: boolean) => Promise<void>;
}

/**
 * Every upcoming event across `buildings`, soonest first.
 *
 * `buildings` gets a new identity on every light tick, so the fetch is keyed on
 * the buildings' *identities* (server, account, guild) and not on the array —
 * otherwise a call running anywhere would refetch every guild's events once a
 * second.
 */
export function useComingUp(
  buildings: readonly BuildingLight[],
  nowMs: number = Date.now(),
  max: number = COMING_UP_CAP,
): ComingUp {
  const targetKey = JSON.stringify(
    buildings.map((building) => [
      building.key,
      building.scope.serverId,
      building.scope.userId,
      building.guildId,
    ]),
  );
  const targets = useMemo<Target[]>(
    () =>
      (JSON.parse(targetKey) as Array<[string, string, string, string]>).map(
        ([buildingKey, serverId, userId, guildId]) => ({
          buildingKey,
          scope: { serverId, userId },
          guildId,
        }),
      ),
    [targetKey],
  );

  const [fetched, setFetched] = useState<FetchedEvent[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const handler = () => setReloadToken((value) => value + 1);
    window.addEventListener(EVENTS_CHANGED, handler);
    return () => window.removeEventListener(EVENTS_CHANGED, handler);
  }, []);

  useEffect(() => {
    if (targets.length === 0) {
      setFetched([]);
      return;
    }
    let disposed = false;
    const open: Array<{ dispose: () => void }> = [];
    void (async () => {
      const perBuilding = await Promise.all(
        targets.map(async (target) => {
          let context: ReturnType<typeof captureScopedOperation>;
          try {
            context = captureScopedOperation(target.scope);
          } catch {
            return [] as FetchedEvent[]; // No signed-in connection for this building.
          }
          open.push(context);
          try {
            const { data } = await context.request<ScheduledEventPayload[]>({
              method: 'GET',
              url: `/guilds/${encodeURIComponent(target.guildId)}/events`,
              timeout: 15_000,
            });
            context.assertCurrent();
            if (!Array.isArray(data)) return [] as FetchedEvent[];
            return data.map((event) => ({ ...event, buildingKey: target.buildingKey }));
          } catch {
            return [] as FetchedEvent[];
          } finally {
            context.dispose();
          }
        }),
      );
      if (!disposed) setFetched(perBuilding.flat());
    })();
    return () => {
      disposed = true;
      for (const context of open) context.dispose();
    };
  }, [targets, reloadToken]);

  // `buildings` changes identity on the light clock, so the join is recomputed
  // rather than refetched — it is a handful of array lookups.
  const buildingsRef = useRef(buildings);
  buildingsRef.current = buildings;

  const events = useMemo<ComingUpEvent[]>(() => {
    const byKey = new Map(buildingsRef.current.map((building) => [building.key, building]));
    const floor = nowMs - ACTIVE_GRACE_MS;
    return fetched
      .flatMap((event) => {
        if (event.status !== SCHEDULED && event.status !== ACTIVE) return [];
        const building = byKey.get(event.buildingKey);
        if (!building) return [];
        const startsAtMs = Date.parse(event.scheduled_start);
        if (!Number.isFinite(startsAtMs) || startsAtMs < floor) return [];
        const room =
          building.rooms.find((entry) => entry.channelId === event.channel_id) ?? null;
        return [
          {
            key: `${event.buildingKey}:${event.id}`,
            buildingKey: event.buildingKey,
            scope: building.scope,
            guildId: building.guildId,
            buildingName: building.name,
            id: event.id,
            name: event.name,
            startsAtMs,
            roomName: room?.name ?? null,
            location: event.location,
            going: Math.max(0, event.user_count ?? 0),
            rsvp: Boolean(event.user_rsvp),
          },
        ];
      })
      .sort((a, b) => a.startsAtMs - b.startsAtMs || a.key.localeCompare(b.key))
      .slice(0, max);
    // `buildings` is read through a ref precisely so a 1 Hz light tick cannot
    // invalidate this memo; `fetched` and the clock are the real inputs.
  }, [fetched, nowMs, max]);

  const setGoing = useCallback(async (event: ComingUpEvent, going: boolean) => {
    let context: ReturnType<typeof captureScopedOperation>;
    try {
      context = captureScopedOperation(event.scope);
    } catch (error) {
      toast.error(`Could not update your RSVP: ${extractApiError(error)}`);
      return;
    }
    try {
      await context.request({
        method: going ? 'PUT' : 'DELETE',
        url: `/guilds/${encodeURIComponent(event.guildId)}/events/${encodeURIComponent(event.id)}/rsvp`,
        timeout: 15_000,
      });
      context.assertCurrent();
      setFetched((current) =>
        current.map((entry) =>
          entry.buildingKey === event.buildingKey && entry.id === event.id
            ? {
                ...entry,
                user_rsvp: going,
                user_count: Math.max(0, (entry.user_count ?? 0) + (going ? 1 : -1)),
              }
            : entry,
        ),
      );
      // Keep a building's own event list in step with what Home just did.
      window.dispatchEvent(new Event(EVENTS_CHANGED));
    } catch (error) {
      toast.error(`Could not update your RSVP: ${extractApiError(error)}`);
    } finally {
      context.dispose();
    }
  }, []);

  return { events, setGoing };
}
