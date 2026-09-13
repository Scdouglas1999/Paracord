import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useCallback, useEffect, useState } from 'react';
import { Calendar, Clock, MapPin, Users, Plus, Check, Download, Repeat, Bell } from 'lucide-react';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { usePermissions } from '../../hooks/usePermissions';
import { Permissions, hasPermission } from '../../types';
import { Modal, ModalTitle } from '../ui/Modal';
import {
  Button,
  Chip,
  ChipTone,
  Divider,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  Tabs,
  Textarea,
  Well,
} from '../ui';
import { Skeleton } from '../ui/Skeleton';
import { FieldLabel } from './SettingsPrimitives';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
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
  status: number; // 1=scheduled, 2=active, 3=completed, 4=cancelled
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
  4: 'Cancelled',
};

// Status is carried by the word first; the chip's ink only seconds it (§9 —
// colour is never the only cue).
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

/** The day tile on an event card (spec §8): mono weekday over a Gabarito date. */
function eventDayTile(dateStr: string): { weekday: string; day: string; month: string } | null {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return null;
  return {
    weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
    day: date.toLocaleDateString(undefined, { day: 'numeric' }),
    month: date.toLocaleDateString(undefined, { month: 'short' }),
  };
}

function eventListError(action: string, err: unknown): string {
  const detail = extractApiError(err);
  return detail ? `${action}: ${detail}` : action;
}

interface EventFormModalProps {
  guildId: string;
  event?: ScheduledEvent;
  onClose: () => void;
  onSaved: (event: ScheduledEvent) => void;
}

function toDateTimeLocalValue(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
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
  { value: '1', label: 'Voice room' },
  { value: '2', label: 'External' },
] as const;

function EventFormModal({ guildId, event, onClose, onSaved }: EventFormModalProps) {
  const [name, setName] = useState(event?.name ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [scheduledStart, setScheduledStart] = useState(toDateTimeLocalValue(event?.scheduled_start));
  const [scheduledEnd, setScheduledEnd] = useState(toDateTimeLocalValue(event?.scheduled_end));
  const [entityType, setEntityType] = useState(event?.entity_type ?? 2); // external by default
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
    if (!name.trim() || !scheduledStart) return;
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
      labelledBy="event-form-title"
      showCloseButton
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
}

export function EventList({ guildId }: EventListProps) {
  const [events, setEvents] = useState<ScheduledEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ScheduledEvent | null>(null);
  const user = useCurrentUser();
  const { permissions, isAdmin } = usePermissions(guildId);
  const canManageEvents = isAdmin || hasPermission(permissions, Permissions.MANAGE_GUILD);

  const fetchEvents = useCallback(() => {
    setLoading(true);
    getApi()
      .get(`/guilds/${guildId}/events`)
      .then(({ data }) => {
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

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Listen for real-time scheduled event changes from the gateway
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.guild_id === guildId) {
        fetchEvents();
      }
    };
    window.addEventListener('paracord:scheduled-events-changed', handler);
    return () => window.removeEventListener('paracord:scheduled-events-changed', handler);
  }, [guildId, fetchEvents]);

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

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} height={104} borderRadius="var(--radius-well)" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="pc-display text-title text-text-primary">Events</h2>
          <p className="mt-1.5 max-w-prose text-body text-text-secondary">
            <span className="pc-mono">{upcoming.length}</span>
            {upcoming.length === 1 ? ' event is' : ' events are'} still to come. Everyone who marks
            themselves interested gets the reminder.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              window.open(
                `/api/v1/guilds/${pathSegment(guildId)}/events.ics`,
                '_blank',
                'noopener,noreferrer',
              )
            }
            title="Export calendar (.ics)"
          >
            <Download size={15} />
            Export
          </Button>
          {canManageEvents && (
            <Button size="sm" onClick={() => setShowCreateModal(true)}>
              <Plus size={15} />
              New event
            </Button>
          )}
        </div>
      </header>

      {loadError ? (
        <ErrorBanner message={loadError} multiline onRetry={fetchEvents} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={<Calendar size={20} />}
          title="No events on the calendar"
          description={
            canManageEvents
              ? 'Schedule one to bring people together — a movie night, a weekly standup, or a launch party.'
              : "Nothing scheduled yet. Check back soon — the organizers will post events here."
          }
          action={
            canManageEvents ? (
              <Button variant="ghost" onClick={() => setShowCreateModal(true)}>
                <Plus size={16} />
                Create event
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {upcoming.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="text-section text-text-faint">Upcoming</h3>
              {upcoming.map((event) => (
                <EventCard
                  key={event.id}
                  guildId={guildId}
                  event={event}
                  onRsvp={handleRsvp}
                  currentUserId={user?.id}
                  canManageEvents={canManageEvents}
                  onRefreshEvent={refreshEvent}
                  onEditEvent={setEditingEvent}
                  onUpdateEventStatus={updateEventStatus}
                  onDeleteEvent={deleteEvent}
                />
              ))}
            </section>
          )}

          {past.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="text-section text-text-faint">Past events</h3>
              {past.map((event) => (
                <EventCard
                  key={event.id}
                  guildId={guildId}
                  event={event}
                  onRsvp={handleRsvp}
                  currentUserId={user?.id}
                  canManageEvents={canManageEvents}
                  onRefreshEvent={refreshEvent}
                  onEditEvent={setEditingEvent}
                  onUpdateEventStatus={updateEventStatus}
                  onDeleteEvent={deleteEvent}
                />
              ))}
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
  onRsvp: (eventId: string, hasRsvp: boolean) => void;
  currentUserId?: string;
  canManageEvents: boolean;
  onRefreshEvent: (eventId: string) => void;
  onEditEvent: (event: ScheduledEvent) => void;
  onUpdateEventStatus: (eventId: string, status: number) => void;
  onDeleteEvent: (eventId: string) => void;
}

/**
 * EventCard — spec §8: a **well**, with a day tile (mono weekday over a
 * Gabarito date), the name, the meta line, and the actions. No bordered box,
 * no status dot: the status is a word in a chip.
 */
function EventCard({
  guildId,
  event,
  onRsvp,
  currentUserId,
  canManageEvents,
  onRefreshEvent,
  onEditEvent,
  onUpdateEventStatus,
  onDeleteEvent,
}: EventCardProps) {
  const isPast = event.status === 3 || event.status === 4;
  const imageUrl = safeClientResourceUrl(event.image_url ?? '');
  const day = eventDayTile(event.scheduled_start);

  return (
    <Well as="section" bare className={cn('flex flex-col gap-3 p-4', isPast && 'opacity-60')}>
      {/* Cover image — framed intentionally, not a full-bleed hero */}
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          className="h-32 w-full rounded-[var(--radius-card)] object-cover"
        />
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 gap-3">
          {day && (
            <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-[var(--radius-card)] bg-bg-raised shadow-[var(--shadow-raised)]">
              <span className="pc-mono text-meta text-text-faint">{day.weekday}</span>
              <span className="pc-display text-name text-text-primary">{day.day}</span>
              <span className="pc-mono text-meta text-text-faint">{day.month}</span>
            </div>
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="pc-display min-w-0 text-name text-text-primary">{event.name}</h4>
              <Chip size="sm" tone={STATUS_TONES[event.status] ?? 'neutral'}>
                {STATUS_LABELS[event.status] || 'Unknown'}
              </Chip>
            </div>

            {event.description && (
              <p className="text-body leading-relaxed text-text-secondary">{event.description}</p>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-meta text-text-faint">
              <span className="inline-flex items-center gap-1.5">
                <Clock size={13} className="shrink-0" aria-hidden />
                <span className="pc-mono">
                  {formatEventDate(event.scheduled_start)}
                  {event.scheduled_end && ` – ${formatEventDate(event.scheduled_end)}`}
                </span>
              </span>
              {event.recurrence_rule && (
                <span className="inline-flex items-center gap-1.5">
                  <Repeat size={13} className="shrink-0" aria-hidden />
                  repeats {event.recurrence_rule}
                </span>
              )}
              {event.reminder_minutes && (
                <span className="inline-flex items-center gap-1.5">
                  <Bell size={13} className="shrink-0" aria-hidden />
                  <span className="pc-mono">{event.reminder_minutes}m</span> before
                </span>
              )}
              {event.location && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin size={13} className="shrink-0" aria-hidden />
                  {event.location}
                </span>
              )}
              {event.event_channel_id && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    window.location.assign(
                      `/app/guilds/${pathSegment(guildId)}/channels/${pathSegment(event.event_channel_id || '')}`,
                    )
                  }
                >
                  event chat
                </Button>
              )}
              <span className="inline-flex items-center gap-1.5">
                <Users size={13} className="shrink-0" aria-hidden />
                <span className="pc-mono">{`${event.user_count} interested`}</span>
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {!isPast && currentUserId && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={event.user_rsvp}
              onClick={() => onRsvp(event.id, event.user_rsvp)}
              className={event.user_rsvp ? 'bg-bg-mod-strong text-text-primary' : undefined}
            >
              <Check size={14} aria-hidden />
              {event.user_rsvp ? 'Interested' : 'Mark interested'}
            </Button>
          )}
          {canManageEvents && (
            <>
              <Button variant="ghost" size="sm" onClick={() => onEditEvent(event)}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onRefreshEvent(event.id)}>
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
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
              </Button>
              {event.status === 1 && (
                <Button variant="ghost" size="sm" onClick={() => onUpdateEventStatus(event.id, 2)}>
                  Start
                </Button>
              )}
              {event.status === 2 && (
                <Button variant="ghost" size="sm" onClick={() => onUpdateEventStatus(event.id, 3)}>
                  Complete
                </Button>
              )}
              {(event.status === 1 || event.status === 2) && (
                <Button variant="ghost" size="sm" onClick={() => onUpdateEventStatus(event.id, 4)}>
                  Cancel
                </Button>
              )}
              <Button variant="danger" size="sm" onClick={() => onDeleteEvent(event.id)}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
    </Well>
  );
}

export function EventsIndicator({ guildId }: { guildId: string }) {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(() => {
    getApi()
      .get(`/guilds/${guildId}/events`)
      .then(({ data }) => {
        const upcoming = (data as ScheduledEvent[]).filter(
          (e) => e.status === 1 || e.status === 2
        );
        setCount(upcoming.length);
      })
      .catch(() => setCount(0));
  }, [guildId]);

  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

  // Listen for real-time scheduled event changes from the gateway
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.guild_id === guildId) {
        fetchCount();
      }
    };
    window.addEventListener('paracord:scheduled-events-changed', handler);
    return () => window.removeEventListener('paracord:scheduled-events-changed', handler);
  }, [guildId, fetchCount]);

  if (count === 0) return null;

  return (
    <Chip size="sm" tone="accent" className="pc-mono">
      {count}
    </Chip>
  );
}
