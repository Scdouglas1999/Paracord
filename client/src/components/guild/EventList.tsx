import { useCurrentUser } from '../../hooks/useCurrentUser';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { usePermissions } from '../../hooks/usePermissions';
import { useServerReadiness } from '../../hooks/useServerReady';
import { Permissions, hasPermission } from '../../types';
import { Modal, ModalTitle } from '../ui/Modal';
import {
  Button,
  Chip,
  ChipTone,
  Divider,
  ErrorBanner,
  Input,
  Select,
  Tabs,
  Textarea,
} from '../ui';
import { useGuildChannels } from '../../hooks/useChannels';
import { dayTile, planWhen } from '../glass/cards/eventTime';
import { EventButton } from '../glass/cards/EventCard';
import { useMinuteNow } from '../glass/cards/useNow';
import { IxGlyph } from '../ix/glyphs';
import { ServerWaitNote } from '../ix/session/ServerWaitNote';
import { EmptyPage } from '../ix/page/EmptyPage';
import { CreamButton, ToolChip } from '../ix/primitives';
import { Skeleton } from '../ui/Skeleton';
import { FieldLabel } from './SettingsPrimitives';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';
import { safeClientResourceUrl } from '../../lib/security';

interface ScheduledEvent {
  id: string;
  guild_id: string;
  channel_id: string | null;
  event_channel_id?: string | null;
  creator_id: string;
  name: string;
  description: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  recurrence_rule?: string | null;
  reminder_minutes?: number | null;
  event_channel_created?: boolean;
  reminder_sent_at?: string | null;
  status: number; // 1=scheduled, 2=active, 3=completed, 4=canceled
  entity_type: number; // 1=voice, 2=external
  location: string | null;
  image_url: string | null;
  user_count: number;
  user_rsvp: boolean;
  created_at: string;
}

const STATUS_LABELS: Record<number, string> = {
  1: 'Scheduled',
  2: 'Active',
  3: 'Completed',
  4: 'Canceled',
};

// Status is carried by the word first; the chip's ink only seconds it (§9 —
// color is never the only cue).
const STATUS_TONES: Record<number, ChipTone> = {
  1: 'neutral',
  2: 'accent',
  3: 'neutral',
  4: 'danger',
};

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function formatEventDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function eventListError(action: string, err: unknown): string {
  const detail = extractApiError(err);
  return detail ? `${action}: ${detail}` : action;
}

/**
 * What a NEW event's form opens with (the empty channel's "Plan a night", IX-15:
 * its Edit puts the draft's name, time and voice channel here). Ignored when
 * editing an existing event.
 */
export interface EventFormDefaults {
  name?: string;
  start?: Date;
  /** A voice channel to hold the event in; sent with the event when its type is a voice channel. */
  channelId?: string | null;
  entityType?: 1 | 2;
}

interface EventFormModalProps {
  guildId: string;
  event?: ScheduledEvent;
  defaults?: EventFormDefaults;
  onClose: () => void;
  onSaved: (event: ScheduledEvent) => void;
}

function toDateTimeLocalValue(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return localInputValue(date);
}

/** `datetime-local` wants wall-clock time, not UTC. */
function localInputValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

/**
 * When a new event starts, and when it ends: the next round hour, an hour long.
 *
 * A `datetime-local` input with an empty value still *paints* today's date and
 * time, so the Start field looked filled when the form had nothing in it. Submit
 * then bailed on `!scheduledStart` without a word — the button did nothing,
 * forever, and no event could be created. Open the form on a real time instead.
 */
export function defaultEventWindow(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(0);
  start.setHours(start.getHours() + 1);
  return {
    start: localInputValue(start),
    end: localInputValue(new Date(start.getTime() + 60 * 60_000)),
  };
}

function toReminderSelectValue(
  minutes: number | null | undefined,
  isEditing: boolean
): 'none' | '10' | '30' | '60' | '1440' {
  if (minutes === 10 || minutes === 30 || minutes === 60 || minutes === 1440) {
    return String(minutes) as '10' | '30' | '60' | '1440';
  }
  return isEditing ? 'none' : '30';
}

const ENTITY_TABS = [
  { value: '1', label: 'Voice channel' },
  { value: '2', label: 'External' },
] as const;

export function EventFormModal({ guildId, event, defaults, onClose, onSaved }: EventFormModalProps) {
  const [name, setName] = useState(event?.name ?? defaults?.name ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const fallbackWindow = useMemo(() => defaultEventWindow(), []);
  const [scheduledStart, setScheduledStart] = useState(
    toDateTimeLocalValue(event?.scheduled_start) ||
      (event ? '' : defaults?.start ? localInputValue(defaults.start) : fallbackWindow.start)
  );
  const [scheduledEnd, setScheduledEnd] = useState(
    toDateTimeLocalValue(event?.scheduled_end) || (event || defaults?.start ? '' : fallbackWindow.end)
  );
  const [entityType, setEntityType] = useState(event?.entity_type ?? defaults?.entityType ?? 2); // external by default
  const [location, setLocation] = useState(event?.location ?? '');
  const [recurrenceRule, setRecurrenceRule] = useState<'none' | 'daily' | 'weekly' | 'monthly'>(
    event?.recurrence_rule === 'daily' || event?.recurrence_rule === 'weekly' || event?.recurrence_rule === 'monthly'
      ? event.recurrence_rule
      : 'none'
  );
  const [reminderMinutes, setReminderMinutes] = useState<'none' | '10' | '30' | '60' | '1440'>(
    toReminderSelectValue(event?.reminder_minutes, Boolean(event))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const isEditing = Boolean(event);

  const handleSubmit = async () => {
    // Say why nothing happened. A bare `return` here is indistinguishable from
    // a dead button.
    if (!name.trim()) {
      setError('Give the event a name.');
      return;
    }
    if (!scheduledStart) {
      setError('Pick when the event starts.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const optionalText = (value: string) => {
        const trimmed = value.trim();
        if (trimmed) return trimmed;
        return isEditing ? null : undefined;
      };
      const payload = {
        name: name.trim(),
        description: optionalText(description),
        scheduled_start: new Date(scheduledStart).toISOString(),
        scheduled_end: scheduledEnd ? new Date(scheduledEnd).toISOString() : (isEditing ? null : undefined),
        entity_type: entityType,
        ...(!isEditing && entityType === 1 && defaults?.channelId ? { channel_id: defaults.channelId } : null),
        location: optionalText(location),
        recurrence_rule: recurrenceRule === 'none' ? (isEditing ? null : undefined) : recurrenceRule,
        reminder_minutes: reminderMinutes === 'none' ? (isEditing ? null : undefined) : Number(reminderMinutes),
      };
      const { data } = isEditing
        ? await getApi().patch(`/guilds/${guildId}/events/${event?.id}`, payload)
        : await getApi().post(`/guilds/${guildId}/events`, payload);
      onSaved(data);
      onClose();
      toast.success(isEditing ? 'Event updated' : 'Event created!');
    } catch (err: unknown) {
      setError(eventListError(isEditing ? 'Failed to update event' : 'Failed to create event', err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      labeledBy="event-form-title"
      showCloseButton
      // The events list lives inside Building settings, a windowed overlay at
      // z-[150]. At the Modal default (z-[60]) this form opened *behind* that
      // plate — the screen dimmed and no event could be created.
      zIndexClassName="z-[160]"
      panelClassName="w-[min(92vw,32rem)]"
    >
      <div className="max-h-[min(86dvh,42rem)] overflow-auto">
        <div className="px-6 pb-5 pr-14 pt-6">
          <ModalTitle id="event-form-title">
            {isEditing ? 'Edit event' : 'Create an event'}
          </ModalTitle>
          <p className="mt-1.5 text-body leading-relaxed text-text-secondary">
            {isEditing
              ? 'Update the details and everyone who RSVP’d gets the change.'
              : 'Give people a reason to show up — a time, a place, and what to expect.'}
          </p>
          {error && <ErrorBanner message={error} multiline className="mt-3" />}
        </div>

        <Divider />

        <div className="flex flex-col gap-5 px-6 py-5">
          <label className="block">
            <FieldLabel>Event Name *</FieldLabel>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="Movie Night"
            />
          </label>

          <label className="block">
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="What's this event about?"
              className="resize-none"
            />
          </label>

          <div className="flex gap-3">
            <label className="block flex-1">
              <FieldLabel>Start *</FieldLabel>
              <Input
                type="datetime-local"
                value={scheduledStart}
                onChange={(e) => setScheduledStart(e.target.value)}
              />
            </label>
            <label className="block flex-1">
              <FieldLabel>End</FieldLabel>
              <Input
                type="datetime-local"
                value={scheduledEnd}
                onChange={(e) => setScheduledEnd(e.target.value)}
              />
            </label>
          </div>

          <div>
            <FieldLabel>Event type</FieldLabel>
            <Tabs
              label="Event type"
              items={ENTITY_TABS}
              value={String(entityType) as '1' | '2'}
              onChange={(next) => setEntityType(Number(next))}
              fill
            />
          </div>

          <div className="flex gap-3">
            <label className="block flex-1">
              <FieldLabel>Repeat</FieldLabel>
              <Select
                value={recurrenceRule}
                onChange={(e) => setRecurrenceRule(e.target.value as 'none' | 'daily' | 'weekly' | 'monthly')}
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </label>
            <label className="block flex-1">
              <FieldLabel>Reminder</FieldLabel>
              <Select
                value={reminderMinutes}
                onChange={(e) => setReminderMinutes(e.target.value as 'none' | '10' | '30' | '60' | '1440')}
              >
                <option value="none">No reminder</option>
                <option value="10">10 min before</option>
                <option value="30">30 min before</option>
                <option value="60">1 hour before</option>
                <option value="1440">1 day before</option>
              </Select>
            </label>
          </div>

          {entityType === 2 && (
            <label className="block">
              <FieldLabel>Location</FieldLabel>
              <Input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={200}
                placeholder="Where is this event?"
              />
            </label>
          )}
        </div>

        <Divider />

        <div className="flex items-center justify-end gap-3 px-6 py-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={loading || !name.trim() || !scheduledStart}
            loading={loading}
            className="min-w-[9rem]"
          >
            {loading ? (isEditing ? 'Saving…' : 'Creating…') : isEditing ? 'Save changes' : 'Create event'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface EventListProps {
  guildId: string;
  /**
   * `page`: the Events page in main (docs/index-spec.md §8.3). The page's large title
   * says "Events" and its subtitle counts what is coming, so the list leaves its own
   * heading out and keeps the actions. `settings` (default): Server settings › Events,
   * which has no title above it, so the list brings its own.
   */
  variant?: 'settings' | 'page';
  /** Called with how many events are still to come, once they are loaded and whenever that changes. */
  onUpcomingCount?: (count: number) => void;
}

export function EventList({ guildId, variant = 'settings', onUpcomingCount }: EventListProps) {
  const [events, setEvents] = useState<ScheduledEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ScheduledEvent | null>(null);
  const user = useCurrentUser();
  const nowMs = useMinuteNow();
  const channels = useGuildChannels(guildId);
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name ?? ''])), [channels]);
  const { permissions, isAdmin } = usePermissions(guildId);
  const canManageEvents = isAdmin || hasPermission(permissions, Permissions.MANAGE_GUILD);
  // The calendar is the selected server's. While that server is still connecting (a
  // relaunch, a restart) there is nothing to ask: the page keeps its loading state and
  // asks once the server is there. Asking at once threw "This server is not connected"
  // out of this effect and into the error boundary, which took the whole page down.
  const readiness = useServerReadiness();
  const { ready } = readiness;

  const loadedFor = useRef<string | null>(null);
  const fetchEvents = useCallback(() => {
    setLoading(true);
    // `async` so a client that is gone by now is a rejection, handled below, not a throw.
    void (async () => (await getApi().get<ScheduledEvent[]>(`/guilds/${guildId}/events`)).data)()
      .then((data) => {
        loadedFor.current = guildId;
        setEvents(data);
        setLoadError('');
      })
      .catch((err: unknown) => {
        setEvents([]);
        setLoadError(eventListError('Failed to load events', err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [guildId]);

  // Once the server is there (at once for the home server). After a blip of its connection
  // the list is already on screen and the gateway's own change events keep it current.
  useEffect(() => {
    if (ready && loadedFor.current !== guildId) fetchEvents();
  }, [ready, guildId, fetchEvents]);

  // Listen for real-time scheduled event changes from the gateway
  useEffect(() => {
    if (!ready) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.guild_id === guildId) {
        fetchEvents();
      }
    };
    window.addEventListener('paracord:scheduled-events-changed', handler);
    return () => window.removeEventListener('paracord:scheduled-events-changed', handler);
  }, [ready, guildId, fetchEvents]);

  const handleRsvp = async (eventId: string, hasRsvp: boolean) => {
    try {
      if (hasRsvp) {
        await getApi().delete(`/guilds/${guildId}/events/${eventId}/rsvp`);
      } else {
        await getApi().put(`/guilds/${guildId}/events/${eventId}/rsvp`);
      }
      setEvents((prev) =>
        prev.map((e) =>
          e.id === eventId
            ? {
                ...e,
                user_rsvp: !hasRsvp,
                user_count: hasRsvp ? e.user_count - 1 : e.user_count + 1,
              }
            : e
        )
      );
    } catch (err: unknown) {
      toast.error(eventListError('Failed to update RSVP', err));
    }
  };

  const refreshEvent = async (eventId: string) => {
    try {
      const { data } = await getApi().get(`/guilds/${guildId}/events/${eventId}`);
      setEvents((prev) => prev.map((event) => (event.id === eventId ? data : event)));
    } catch (err: unknown) {
      toast.error(eventListError('Failed to refresh event details', err));
    }
  };

  const updateEventStatus = async (eventId: string, status: number) => {
    try {
      const { data } = await getApi().patch(`/guilds/${guildId}/events/${eventId}`, { status });
      setEvents((prev) => prev.map((event) => (event.id === eventId ? data : event)));
      toast.success('Event updated');
    } catch (err: unknown) {
      toast.error(eventListError('Failed to update event', err));
    }
  };

  const deleteEvent = async (eventId: string) => {
    if (!(await confirm({ title: 'Delete this event?', confirmLabel: 'Delete', variant: 'danger' }))) return;
    try {
      await getApi().delete(`/guilds/${guildId}/events/${eventId}`);
      setEvents((prev) => prev.filter((event) => event.id !== eventId));
      toast.success('Event deleted');
    } catch (err: unknown) {
      toast.error(eventListError('Failed to delete event', err));
    }
  };

  const upcoming = events.filter((e) => e.status === 1 || e.status === 2);
  const past = events.filter((e) => e.status === 3 || e.status === 4);

  useEffect(() => {
    if (!loading) onUpcomingCount?.(upcoming.length);
  }, [loading, upcoming.length, onUpcomingCount]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {/* A server that is away or signed out says so; connecting is just this loading state. */}
        {!ready && <ServerWaitNote readiness={readiness} />}
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} height={104} borderRadius="var(--radius-well)" />
        ))}
      </div>
    );
  }

  const page = variant === 'page';
  const cards = (list: ScheduledEvent[]) =>
    list.map((event) => (
      <EventCard
        key={event.id}
        guildId={guildId}
        event={event}
        nowMs={nowMs}
        channelName={channelNames.get(event.channel_id ?? '') ?? null}
        onRsvp={handleRsvp}
        currentUserId={user?.id}
        canManageEvents={canManageEvents}
        onRefreshEvent={refreshEvent}
        onEditEvent={setEditingEvent}
        onUpdateEventStatus={updateEventStatus}
        onDeleteEvent={deleteEvent}
      />
    ));

  const actions = (
    <div className="ix-events__tools">
      <ToolChip
        onClick={() =>
          window.open(
            `/api/v1/guilds/${pathSegment(guildId)}/events.ics`,
            '_blank',
            'noopener,noreferrer',
          )
        }
        title="Export calendar (.ics)"
      >
        <Download size={14} aria-hidden />
        Export
      </ToolChip>
      {canManageEvents && (
        <CreamButton size="sm" onClick={() => setShowCreateModal(true)}>
          <IxGlyph name="plus" size={14} />
          New event
        </CreamButton>
      )}
    </div>
  );

  return (
    <div className="ix-events" data-variant={variant}>
      {page ? (
        <div className="ix-events__bar">{actions}</div>
      ) : (
        <header className="ix-events__head">
          <div className="min-w-0">
            <h2 className="ix-events__title">Events</h2>
            <p className="ix-events__sub">
              <span className="ix-num">{upcoming.length}</span>
              {upcoming.length === 1 ? ' event is' : ' events are'} still to come. Everyone who marks
              themselves interested gets the reminder.
            </p>
          </div>
          {actions}
        </header>
      )}

      {loadError ? (
        <div role="alert" className="ix-note" data-tone="danger">
          <span>{loadError}</span>
          <button type="button" className="ix-link" onClick={fetchEvents}>
            Try again
          </button>
        </div>
      ) : events.length === 0 ? (
        <EmptyPage
          inline
          glyph="event"
          title="No events on the calendar"
          line={
            canManageEvents
              ? 'Schedule one to bring people together — a movie night, a weekly standup, or a launch party.'
              : 'Nothing scheduled yet. Check back soon — the organizers will post events here.'
          }
          action={
            canManageEvents ? (
              <CreamButton onClick={() => setShowCreateModal(true)}>Create event</CreamButton>
            ) : undefined
          }
        />
      ) : (
        <>
          {upcoming.length > 0 && (
            <section className="ix-events__group" aria-label="Upcoming events">
              <h3 className="ix-events__label">Upcoming</h3>
              {cards(upcoming)}
            </section>
          )}

          {past.length > 0 && (
            <section className="ix-events__group" aria-label="Past events">
              <h3 className="ix-events__label">Past events</h3>
              {cards(past)}
            </section>
          )}
        </>
      )}

      {showCreateModal && (
        <EventFormModal
          guildId={guildId}
          onClose={() => setShowCreateModal(false)}
          onSaved={(event) => setEvents((prev) => [event, ...prev])}
        />
      )}

      {editingEvent && (
        <EventFormModal
          guildId={guildId}
          event={editingEvent}
          onClose={() => setEditingEvent(null)}
          onSaved={(updated) =>
            setEvents((prev) => prev.map((event) => (event.id === updated.id ? updated : event)))
          }
        />
      )}
    </div>
  );
}

interface EventCardProps {
  guildId: string;
  event: ScheduledEvent;
  nowMs: number;
  /** The event's voice channel, by name, for "in Lounge". */
  channelName: string | null;
  onRsvp: (eventId: string, hasRsvp: boolean) => void;
  currentUserId?: string;
  canManageEvents: boolean;
  onRefreshEvent: (eventId: string) => void;
  onEditEvent: (event: ScheduledEvent) => void;
  onUpdateEventStatus: (eventId: string, status: number) => void;
  onDeleteEvent: (eventId: string) => void;
}

/**
 * One event, as a card of the event-card family (docs/index-spec.md §3.1, §4.11): the
 * calendar tile, the title with its state as a word, one line of when and where, and a
 * row of actions: "I'm in" (cream) for anyone, and the manager's own. The status is a
 * word first; the tile and the title only second it (color is never the only cue).
 */
function EventCard({
  guildId,
  event,
  nowMs,
  channelName,
  onRsvp,
  currentUserId,
  canManageEvents,
  onRefreshEvent,
  onEditEvent,
  onUpdateEventStatus,
  onDeleteEvent,
}: EventCardProps) {
  const isPast = event.status === 3 || event.status === 4;
  const live = event.status === 2;
  const imageUrl = safeClientResourceUrl(event.image_url ?? '');
  const start = new Date(event.scheduled_start);
  const end = event.scheduled_end ? new Date(event.scheduled_end) : null;
  const valid = !Number.isNaN(start.getTime());
  const tile = valid ? dayTile(start) : null;
  const when = valid ? planWhen(start, { nowMs, endsAt: end, happeningNow: live }) : formatEventDate(event.scheduled_start);
  const parts: ReactNode[] = [when];
  if (channelName) parts.push(`in ${channelName}`);
  if (event.location) parts.push(event.location);
  parts.push(`${event.user_count} interested`);
  if (event.recurrence_rule) parts.push(`repeats ${event.recurrence_rule}`);
  if (event.reminder_minutes) parts.push(`${event.reminder_minutes} min before`);
  const chatId = event.event_channel_id;

  return (
    <article
      className="ix-card ix-event ix-events__card"
      aria-label={`Event: ${event.name}`}
      data-tone={live ? 'live' : event.status === 4 ? 'canceled' : isPast ? 'over' : undefined}
    >
      {imageUrl && <img src={imageUrl} alt="" className="ix-events__cover" />}
      {tile ? (
        <div className="ix-event__day ix-hue-weekday" aria-hidden>
          <small>{tile.weekday}</small>
          <b>{tile.day}</b>
        </div>
      ) : (
        <div className="ix-event__day" aria-hidden />
      )}
      <p className="ix-event__title">
        {event.name}
        <span className="ix-events__state" data-tone={STATUS_TONES[event.status] ?? 'neutral'}>
          {STATUS_LABELS[event.status] || 'Unknown'}
        </span>
      </p>
      <p className="ix-event__meta">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 && <span aria-hidden> · </span>}
            <span className="ix-event__part">{part}</span>
          </Fragment>
        ))}
      </p>
      {event.description && <p className="ix-events__about">{event.description}</p>}

      <div className="ix-event__acts">
        {!isPast && currentUserId && (
          <EventButton
            primary={!event.user_rsvp}
            pressed={event.user_rsvp}
            check={event.user_rsvp}
            aria-pressed={event.user_rsvp}
            onClick={() => onRsvp(event.id, event.user_rsvp)}
          >
            {event.user_rsvp ? 'You’re in' : 'I’m in'}
          </EventButton>
        )}
        {chatId && (
          <EventButton
            onClick={() => window.location.assign(`/app/guilds/${pathSegment(guildId)}/channels/${pathSegment(chatId)}`)}
          >
            Event chat
          </EventButton>
        )}
        {canManageEvents && (
          <>
            <EventButton className="ix-event__btn--quiet" onClick={() => onEditEvent(event)}>
              Edit
            </EventButton>
            <EventButton className="ix-event__btn--quiet" onClick={() => onRefreshEvent(event.id)}>
              Refresh
            </EventButton>
            <EventButton
              className="ix-event__btn--quiet"
              onClick={() =>
                window.open(
                  `/api/v1/guilds/${pathSegment(guildId)}/events/${pathSegment(event.id)}/ical`,
                  '_blank',
                  'noopener,noreferrer',
                )
              }
            >
              <Download size={13} aria-hidden />
              iCal
            </EventButton>
            {event.status === 1 && (
              <EventButton className="ix-event__btn--quiet" onClick={() => onUpdateEventStatus(event.id, 2)}>
                Start
              </EventButton>
            )}
            {event.status === 2 && (
              <EventButton className="ix-event__btn--quiet" onClick={() => onUpdateEventStatus(event.id, 3)}>
                Complete
              </EventButton>
            )}
            {(event.status === 1 || event.status === 2) && (
              <EventButton className="ix-event__btn--quiet" onClick={() => onUpdateEventStatus(event.id, 4)}>
                Cancel
              </EventButton>
            )}
            <EventButton className="ix-event__btn--danger" onClick={() => onDeleteEvent(event.id)}>
              Delete
            </EventButton>
          </>
        )}
      </div>
    </article>
  );
}

export function EventsIndicator({ guildId }: { guildId: string }) {
  const [count, setCount] = useState(0);
  const ready = useServerReadiness().ready;

  const fetchCount = useCallback(() => {
    void (async () => (await getApi().get<ScheduledEvent[]>(`/guilds/${guildId}/events`)).data)()
      .then((data) => {
        const upcoming = data.filter((e) => e.status === 1 || e.status === 2);
        setCount(upcoming.length);
      })
      .catch(() => setCount(0));
  }, [guildId]);

  useEffect(() => {
    if (ready) fetchCount();
  }, [ready, fetchCount]);

  // Listen for real-time scheduled event changes from the gateway
  useEffect(() => {
    if (!ready) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.guild_id === guildId) {
        fetchCount();
      }
    };
    window.addEventListener('paracord:scheduled-events-changed', handler);
    return () => window.removeEventListener('paracord:scheduled-events-changed', handler);
  }, [ready, guildId, fetchCount]);

  if (count === 0) return null;

  return (
    <Chip size="sm" tone="accent" className="glass-instrument">
      {count}
    </Chip>
  );
}
