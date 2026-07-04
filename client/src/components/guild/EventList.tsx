import { useCallback, useEffect, useState } from 'react';
import { Calendar, Clock, MapPin, Users, Plus, Check, Download, Repeat, Bell } from 'lucide-react';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { useAuthStore } from '../../stores/authStore';
import { usePermissions } from '../../hooks/usePermissions';
import { Permissions, hasPermission } from '../../types';
import { Modal, ModalTitle } from '../ui/Modal';
import { Button } from '../ui/Button';
import { EmptyState, ErrorBanner } from '../ui/Feedback';
import { FieldLabel } from './SettingsPrimitives';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { confirm } from '../../stores/confirmStore';

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

const STATUS_COLORS: Record<number, string> = {
  1: 'border-accent-primary/40 bg-accent-tint text-accent-primary',
  2: 'border-accent-success/40 bg-success-tint text-accent-success',
  3: 'border-border-subtle bg-bg-mod-strong text-text-muted',
  4: 'border-accent-danger/40 bg-danger-tint text-accent-danger',
};

// Compact management-action button: quiet neutral by default, semantic tint variants.
const eventActionBtn = (variant: 'neutral' | 'primary' | 'success' | 'warning' | 'danger') =>
  cn(
    'inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-3 py-1.5 text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
    variant === 'neutral' &&
      'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary',
    variant === 'primary' &&
      'border-accent-primary/40 bg-accent-tint text-accent-primary hover:bg-accent-tint-strong',
    variant === 'success' &&
      'border-accent-success/40 bg-success-tint text-accent-success hover:bg-success-tint',
    variant === 'warning' &&
      'border-accent-warning/40 bg-warning-tint text-accent-warning hover:bg-warning-tint',
    variant === 'danger' &&
      'border-accent-danger/40 bg-danger-tint text-accent-danger hover:bg-danger-tint',
  );

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
        <div className="border-b border-border-subtle px-6 pb-5 pt-6 pr-14">
          <ModalTitle id="event-form-title">
            {isEditing ? 'Edit event' : 'Create an event'}
          </ModalTitle>
          <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
            {isEditing
              ? 'Update the details and everyone who RSVP’d gets the change.'
              : 'Give people a reason to show up — a time, a place, and what to expect.'}
          </p>
          {error && <ErrorBanner message={error} className="mt-3" />}
        </div>

        <div className="space-y-5 px-6 py-5">
          <label className="block">
            <FieldLabel>Event Name *</FieldLabel>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="Movie Night"
              className="input-field"
            />
          </label>

          <label className="block">
            <FieldLabel>Description</FieldLabel>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="What's this event about?"
              className="input-field resize-none"
            />
          </label>

          <div className="flex gap-3">
            <label className="block flex-1">
              <FieldLabel>Start *</FieldLabel>
              <input
                type="datetime-local"
                value={scheduledStart}
                onChange={(e) => setScheduledStart(e.target.value)}
                className="input-field"
              />
            </label>
            <label className="block flex-1">
              <FieldLabel>End</FieldLabel>
              <input
                type="datetime-local"
                value={scheduledEnd}
                onChange={(e) => setScheduledEnd(e.target.value)}
                className="input-field"
              />
            </label>
          </div>

          <div>
            <FieldLabel>Event Type</FieldLabel>
            <div className="flex gap-2">
              {([
                { type: 1, label: 'Voice Channel' },
                { type: 2, label: 'External' },
              ] as const).map(({ type, label }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setEntityType(type)}
                  className={cn(
                    'flex-1 rounded-sm border px-3 py-2.5 text-label font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                    entityType === type
                      ? 'border-accent-primary bg-accent-tint text-text-primary'
                      : 'border-border-subtle bg-bg-tertiary text-text-secondary hover:border-border-strong hover:bg-bg-mod-subtle',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <label className="block flex-1">
              <FieldLabel>Repeat</FieldLabel>
              <select
                value={recurrenceRule}
                onChange={(e) => setRecurrenceRule(e.target.value as 'none' | 'daily' | 'weekly' | 'monthly')}
                className="select-field"
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="block flex-1">
              <FieldLabel>Reminder</FieldLabel>
              <select
                value={reminderMinutes}
                onChange={(e) => setReminderMinutes(e.target.value as 'none' | '10' | '30' | '60' | '1440')}
                className="select-field"
              >
                <option value="none">No reminder</option>
                <option value="10">10 min before</option>
                <option value="30">30 min before</option>
                <option value="60">1 hour before</option>
                <option value="1440">1 day before</option>
              </select>
            </label>
          </div>

          {entityType === 2 && (
            <label className="block">
              <FieldLabel>Location</FieldLabel>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={200}
                placeholder="Where is this event?"
                className="input-field"
              />
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border-subtle bg-bg-secondary px-6 py-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={loading || !name.trim() || !scheduledStart}
            loading={loading}
            className="min-w-[9rem]"
          >
            {loading ? (isEditing ? 'Saving…' : 'Creating…') : isEditing ? 'Save Changes' : 'Create Event'}
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
  const user = useAuthStore((s) => s.user);
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
      <div className="space-y-3 p-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-md border border-border-subtle bg-bg-secondary" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border-subtle bg-bg-secondary text-accent-primary shadow-sm">
            <Calendar size={18} />
          </div>
          <div>
            <h2 className="font-display text-heading text-text-primary">Events</h2>
            <p className="text-meta text-text-muted">
              {upcoming.length} upcoming event{upcoming.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              window.open(
                `/api/v1/guilds/${pathSegment(guildId)}/events.ics`,
                '_blank',
                'noopener,noreferrer',
              )
            }
            className="gap-1.5"
            title="Export calendar (.ics)"
          >
            <Download size={15} />
            Export
          </Button>
          {canManageEvents && (
            <Button size="sm" onClick={() => setShowCreateModal(true)} className="gap-1.5">
              <Plus size={15} />
              New Event
            </Button>
          )}
        </div>
      </div>

      {loadError ? (
        <ErrorBanner message={loadError} onRetry={fetchEvents} />
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
              <Button onClick={() => setShowCreateModal(true)} className="gap-1.5">
                <Plus size={16} />
                Create event
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {upcoming.length > 0 && (
            <div className="space-y-3">
              <h3 className="px-0.5 text-section uppercase text-text-muted">Upcoming</h3>
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
            </div>
          )}

          {past.length > 0 && (
            <div className="space-y-3">
              <h3 className="px-0.5 text-section uppercase text-text-muted">Past events</h3>
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
            </div>
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

  return (
    <article
      className={cn(
        'group overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong',
        isPast && 'opacity-60'
      )}
    >
      {/* Cover image — framed intentionally, not a full-bleed hero */}
      {event.image_url && (
        <img
          src={event.image_url}
          alt=""
          className="h-32 w-full border-b border-border-subtle object-cover"
        />
      )}

      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-label font-semibold text-text-primary">{event.name}</h4>
            <span
              className={cn(
                'inline-flex items-center rounded-xs border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]',
                STATUS_COLORS[event.status] || STATUS_COLORS[1]
              )}
            >
              {STATUS_LABELS[event.status] || 'Unknown'}
            </span>
          </div>

          {event.description && (
            <p className="text-meta leading-relaxed text-text-secondary">{event.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-meta text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={13} className="shrink-0" />
              <span className="font-code tabular-nums">
                {formatEventDate(event.scheduled_start)}
                {event.scheduled_end && ` – ${formatEventDate(event.scheduled_end)}`}
              </span>
            </span>
            {event.recurrence_rule && (
              <span className="inline-flex items-center gap-1.5">
                <Repeat size={13} className="shrink-0" />
                repeats {event.recurrence_rule}
              </span>
            )}
            {event.reminder_minutes && (
              <span className="inline-flex items-center gap-1.5">
                <Bell size={13} className="shrink-0" />
                {event.reminder_minutes}m before
              </span>
            )}
            {event.location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={13} className="shrink-0" />
                {event.location}
              </span>
            )}
            {event.event_channel_id && (
              <button
                type="button"
                onClick={() =>
                  window.location.assign(
                    `/app/guilds/${pathSegment(guildId)}/channels/${pathSegment(event.event_channel_id || '')}`,
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-sm border border-border-subtle px-2 py-0.5 text-meta text-text-secondary outline-none transition-colors hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
              >
                event chat
              </button>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Users size={13} className="shrink-0" />
              {event.user_count} interested
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isPast && currentUserId && (
            <button
              onClick={() => onRsvp(event.id, event.user_rsvp)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-3 py-1.5 text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                event.user_rsvp
                  ? 'border-accent-success/50 bg-success-tint text-accent-success hover:bg-success-tint'
                  : 'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary'
              )}
            >
              <Check size={14} />
              {event.user_rsvp ? 'Interested' : 'Mark Interested'}
            </button>
          )}
          {canManageEvents && (
            <>
              <button onClick={() => onEditEvent(event)} className={eventActionBtn('neutral')}>
                Edit
              </button>
              <button onClick={() => onRefreshEvent(event.id)} className={eventActionBtn('neutral')}>
                Refresh
              </button>
              <button
                onClick={() =>
                  window.open(
                    `/api/v1/guilds/${pathSegment(guildId)}/events/${pathSegment(event.id)}/ical`,
                    '_blank',
                    'noopener,noreferrer',
                  )
                }
                className={eventActionBtn('neutral')}
              >
                <Download size={13} />
                iCal
              </button>
              {event.status === 1 && (
                <button onClick={() => onUpdateEventStatus(event.id, 2)} className={eventActionBtn('primary')}>
                  Start
                </button>
              )}
              {event.status === 2 && (
                <button onClick={() => onUpdateEventStatus(event.id, 3)} className={eventActionBtn('success')}>
                  Complete
                </button>
              )}
              {(event.status === 1 || event.status === 2) && (
                <button onClick={() => onUpdateEventStatus(event.id, 4)} className={eventActionBtn('warning')}>
                  Cancel
                </button>
              )}
              <button onClick={() => onDeleteEvent(event.id)} className={eventActionBtn('danger')}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </article>
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
    <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent-primary px-1 text-[9px] font-bold tabular-nums text-text-on-accent">
      {count}
    </span>
  );
}
