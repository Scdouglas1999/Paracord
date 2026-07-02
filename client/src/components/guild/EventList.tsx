import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, Clock, MapPin, Users, Plus, X, Check, Sparkles, Download, Repeat } from 'lucide-react';
import { apiClient, extractApiError } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { usePermissions } from '../../hooks/usePermissions';
import { Permissions, hasPermission } from '../../types';
import { useFocusTrap } from '../../hooks/useFocusTrap';
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
  1: 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary',
  2: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
  3: 'border-text-muted/40 bg-text-muted/10 text-text-muted',
  4: 'border-accent-danger/40 bg-accent-danger/10 text-accent-danger',
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
  const dialogRef = useRef<HTMLDivElement>(null);
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

  useFocusTrap(dialogRef, true, onClose);

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
        ? await apiClient.patch(`/guilds/${guildId}/events/${event?.id}`, payload)
        : await apiClient.post(`/guilds/${guildId}/events`, payload);
      onSaved(data);
      onClose();
      toast.success(isEditing ? 'Event updated' : 'Event created!');
    } catch (err: unknown) {
      setError(eventListError(isEditing ? 'Failed to update event' : 'Failed to create event', err));
    } finally {
      setLoading(false);
    }
  };

  const modal = (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-form-title"
        tabIndex={-1}
        className="glass-modal modal-content max-h-[min(86dvh,42rem)] w-[min(92vw,32rem)] overflow-auto rounded-2xl border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative px-8 pb-4 pt-8">
          <button onClick={onClose} className="icon-btn absolute right-3 top-3" aria-label="Close">
            <X size={20} />
          </button>
          <h2 id="event-form-title" className="text-xl font-bold text-text-primary">
            {isEditing ? 'Edit Event' : 'Create Event'}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {isEditing ? 'Update the event details for your server.' : 'Schedule a new event for your server.'}
          </p>
          {error && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-sm font-medium text-accent-danger"
            >
              {error}
            </p>
          )}
        </div>

        <div className="space-y-5 px-8 pb-6">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Event Name *
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="Movie Night"
              className="input-field mt-2"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="What's this event about?"
              className="input-field mt-2 resize-none"
            />
          </label>

          <div className="flex gap-3">
            <label className="block flex-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Start *
              </span>
              <input
                type="datetime-local"
                value={scheduledStart}
                onChange={(e) => setScheduledStart(e.target.value)}
                className="input-field mt-2"
              />
            </label>
            <label className="block flex-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                End
              </span>
              <input
                type="datetime-local"
                value={scheduledEnd}
                onChange={(e) => setScheduledEnd(e.target.value)}
                className="input-field mt-2"
              />
            </label>
          </div>

          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Event Type
            </span>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setEntityType(1)}
                className={cn(
                  'flex-1 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors',
                  entityType === 1
                    ? 'border-accent-primary/50 bg-accent-primary/15 text-text-primary'
                    : 'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong'
                )}
              >
                Voice Channel
              </button>
              <button
                type="button"
                onClick={() => setEntityType(2)}
                className={cn(
                  'flex-1 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors',
                  entityType === 2
                    ? 'border-accent-primary/50 bg-accent-primary/15 text-text-primary'
                    : 'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong'
                )}
              >
                External
              </button>
            </div>
          </div>

          <div className="flex gap-3">
            <label className="block flex-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Repeat
              </span>
              <select
                value={recurrenceRule}
                onChange={(e) => setRecurrenceRule(e.target.value as 'none' | 'daily' | 'weekly' | 'monthly')}
                className="input-field mt-2"
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="block flex-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Reminder
              </span>
              <select
                value={reminderMinutes}
                onChange={(e) => setReminderMinutes(e.target.value as 'none' | '10' | '30' | '60' | '1440')}
                className="input-field mt-2"
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
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Location
              </span>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={200}
                placeholder="Where is this event?"
                className="input-field mt-2"
              />
            </label>
          )}
        </div>

        <div className="flex flex-col-reverse items-stretch gap-5 border-t border-border-subtle/70 px-8 py-6 sm:flex-row sm:items-center sm:justify-between"
          style={{ backgroundColor: 'var(--bg-secondary)' }}
        >
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button
            onClick={() => void handleSubmit()}
            disabled={loading || !name.trim() || !scheduledStart}
            className="btn-primary min-w-[9rem]"
          >
            {loading ? (isEditing ? 'Saving...' : 'Creating...') : isEditing ? 'Save Changes' : 'Create Event'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
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
    apiClient
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
        await apiClient.delete(`/guilds/${guildId}/events/${eventId}/rsvp`);
      } else {
        await apiClient.put(`/guilds/${guildId}/events/${eventId}/rsvp`);
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
      const { data } = await apiClient.get(`/guilds/${guildId}/events/${eventId}`);
      setEvents((prev) => prev.map((event) => (event.id === eventId ? data : event)));
    } catch (err: unknown) {
      toast.error(eventListError('Failed to refresh event details', err));
    }
  };

  const updateEventStatus = async (eventId: string, status: number) => {
    try {
      const { data } = await apiClient.patch(`/guilds/${guildId}/events/${eventId}`, { status });
      setEvents((prev) => prev.map((event) => (event.id === eventId ? data : event)));
      toast.success('Event updated');
    } catch (err: unknown) {
      toast.error(eventListError('Failed to update event', err));
    }
  };

  const deleteEvent = async (eventId: string) => {
    if (!(await confirm({ title: 'Delete this event?', confirmLabel: 'Delete', variant: 'danger' }))) return;
    try {
      await apiClient.delete(`/guilds/${guildId}/events/${eventId}`);
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
          <div key={i} className="h-24 animate-pulse rounded-xl border border-border-subtle bg-bg-mod-subtle/40" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-text-secondary">
            <Calendar size={18} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Events</h2>
            <p className="text-xs text-text-muted">
              {upcoming.length} upcoming event{upcoming.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() =>
              window.open(
                `/api/v1/guilds/${pathSegment(guildId)}/events.ics`,
                '_blank',
                'noopener,noreferrer',
              )
            }
            className="control-pill-btn gap-1.5"
            title="Export calendar (.ics)"
          >
            <Download size={15} />
            Export
          </button>
          {canManageEvents && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="control-pill-btn gap-1.5"
            >
              <Plus size={15} />
              New Event
            </button>
          )}
        </div>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{loadError}</span>
            <button
              type="button"
              onClick={fetchEvents}
              className="inline-flex shrink-0 items-center justify-center rounded-lg border border-accent-danger/35 px-3 py-1.5 text-xs font-semibold hover:bg-accent-danger/10"
            >
              Retry
            </button>
          </div>
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle">
            <Sparkles size={28} className="text-text-muted" />
          </div>
          <p className="text-sm font-semibold text-text-secondary">No events yet</p>
          <p className="mt-1 text-xs text-text-muted">
            {canManageEvents
              ? 'Create the first event for this server!'
              : 'Check back later for upcoming events.'}
          </p>
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <div className="space-y-3">
              <h3 className="px-1 text-xs font-bold uppercase tracking-wider text-text-muted/70">
                Upcoming
              </h3>
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
              <h3 className="px-1 text-xs font-bold uppercase tracking-wider text-text-muted/70">
                Past Events
              </h3>
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
    <div
      className={cn(
        'group rounded-xl border border-border-subtle/70 bg-bg-mod-subtle/45 p-4 transition-colors hover:border-border-strong hover:bg-bg-mod-strong/55',
        isPast && 'opacity-60'
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-text-primary">{event.name}</h4>
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                STATUS_COLORS[event.status] || STATUS_COLORS[1]
              )}
            >
              {STATUS_LABELS[event.status] || 'Unknown'}
            </span>
          </div>

          {event.description && (
            <p className="text-xs leading-relaxed text-text-secondary">{event.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-4 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={12} />
              {formatEventDate(event.scheduled_start)}
              {event.scheduled_end && ` - ${formatEventDate(event.scheduled_end)}`}
            </span>
            {event.recurrence_rule && (
              <span className="inline-flex items-center gap-1.5">
                <Repeat size={12} />
                repeats {event.recurrence_rule}
              </span>
            )}
            {event.reminder_minutes && (
              <span className="inline-flex items-center gap-1.5">
                reminder {event.reminder_minutes}m
              </span>
            )}
            {event.location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={12} />
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
                className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary hover:bg-bg-mod-subtle"
              >
                event chat
              </button>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Users size={12} />
              {event.user_count} interested
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isPast && currentUserId && (
            <button
              onClick={() => onRsvp(event.id, event.user_rsvp)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
                event.user_rsvp
                  ? 'border-accent-success/50 bg-accent-success/15 text-accent-success hover:bg-accent-success/25'
                  : 'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary'
              )}
            >
              <Check size={14} />
              {event.user_rsvp ? 'Interested' : 'Mark Interested'}
            </button>
          )}
          {canManageEvents && (
            <>
              <button
                onClick={() => onEditEvent(event)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              >
                Edit
              </button>
              <button
                onClick={() => onRefreshEvent(event.id)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              >
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
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              >
                <Download size={13} />
                iCal
              </button>
              {event.status === 1 && (
                <button
                  onClick={() => onUpdateEventStatus(event.id, 2)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-accent-primary/40 bg-accent-primary/12 px-3 py-2 text-xs font-semibold text-accent-primary transition-colors hover:bg-accent-primary/20"
                >
                  Start
                </button>
              )}
              {event.status === 2 && (
                <button
                  onClick={() => onUpdateEventStatus(event.id, 3)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-accent-success/40 bg-accent-success/12 px-3 py-2 text-xs font-semibold text-accent-success transition-colors hover:bg-accent-success/20"
                >
                  Complete
                </button>
              )}
              {(event.status === 1 || event.status === 2) && (
                <button
                  onClick={() => onUpdateEventStatus(event.id, 4)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-accent-warning/40 bg-accent-warning/12 px-3 py-2 text-xs font-semibold text-accent-warning transition-colors hover:bg-accent-warning/20"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={() => onDeleteEvent(event.id)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-accent-danger/40 bg-accent-danger/12 px-3 py-2 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/20"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function EventsIndicator({ guildId }: { guildId: string }) {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(() => {
    apiClient
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
    <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent-primary/20 px-1 text-[9px] font-bold text-accent-primary">
      {count}
    </span>
  );
}
