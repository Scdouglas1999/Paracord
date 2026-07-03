import { Fragment, useState, useEffect } from 'react';
import { adminApi, type SecurityEvent } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';

export function SecurityPanel() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const [appliedAction, setAppliedAction] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const pageLimit = 25;

  useEffect(() => {
    let cancelled = false;
    const fetchEvents = async () => {
      setLoading(true);
      try {
        const { data } = await adminApi.listSecurityEvents({
          limit: pageLimit + 1,
          before: cursor ?? undefined,
          action: appliedAction || undefined,
        });
        if (cancelled) return;
        const pageEvents = data.slice(0, pageLimit);
        setEvents(pageEvents);
        setNextCursor(data.length > pageLimit && pageEvents.length > 0
          ? pageEvents[pageEvents.length - 1].id
          : null);
        setExpandedEventId(null);
      } catch (err) {
        if (!cancelled) {
          toast.error(`Failed to load security events: ${extractApiError(err)}`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void fetchEvents();
    return () => {
      cancelled = true;
    };
  }, [appliedAction, cursor, reloadKey]);

  const applyFilter = () => {
    setCursorStack([]);
    setCursor(null);
    setAppliedAction(actionFilter.trim());
    setReloadKey((key) => key + 1);
  };

  const goPreviousPage = () => {
    setCursorStack((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const previousCursor = next.pop() ?? null;
      setCursor(previousCursor);
      return next;
    });
  };

  const goNextPage = () => {
    if (nextCursor === null) return;
    setCursorStack((prev) => [...prev, cursor]);
    setCursor(nextCursor);
  };

  const formatDetails = (event: SecurityEvent) => {
    const blocks: Array<[string, string]> = [];
    if (event.device_id) blocks.push(['Device', event.device_id]);
    if (event.user_agent) blocks.push(['User agent', event.user_agent]);
    if (event.details && Object.keys(event.details).length > 0) {
      blocks.push(['Details', JSON.stringify(event.details, null, 2)]);
    }
    return blocks;
  };

  const pageIndex = cursorStack.length + 1;

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Security Events</h2>
          <p className="text-sm text-text-muted">Recent authentication and admin activity.</p>
        </div>
        <button
          onClick={() => setReloadKey((key) => key + 1)}
          className="control-pill-btn h-10 px-4 text-sm"
        >
          Refresh
        </button>
      </div>

      <div className="mb-6 flex gap-3">
        <label htmlFor="admin-security-action-filter" className="sr-only">
          Filter security events by exact action
        </label>
        <input
          id="admin-security-action-filter"
          type="text"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="Exact action (e.g. auth.login)"
          className="input-field max-w-md"
        />
        <button
          onClick={applyFilter}
          className="control-pill-btn h-10 px-4 text-sm"
        >
          Apply
        </button>
      </div>

      {loading ? (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-6 text-sm text-text-muted">
          Loading security events...
        </div>
      ) : events.length === 0 ? (
        <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-10 text-center text-text-muted">
          No security events found.
        </div>
      ) : (
        <div className="card-surface overflow-hidden rounded-xl border border-border-subtle bg-bg-mod-subtle/40">
          <div className="overflow-x-auto">
          <table className="min-w-[960px] w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-secondary/60">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Time</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Action</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Actor</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Target</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">IP</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Session</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const details = formatDetails(event);
                const expanded = expandedEventId === event.id;
                return (
                  <Fragment key={event.id}>
                    <tr className="border-b border-border-subtle/50 align-top hover:bg-bg-mod-subtle/20">
                      <td className="px-4 py-3 text-text-secondary">{new Date(event.created_at).toLocaleString()}</td>
                      <td className="px-4 py-3 font-medium text-text-primary">{event.action}</td>
                      <td className="px-4 py-3 text-text-secondary">{event.actor_user_id || '-'}</td>
                      <td className="px-4 py-3 text-text-secondary">{event.target_user_id || '-'}</td>
                      <td className="px-4 py-3 text-text-secondary">{event.ip_address || '-'}</td>
                      <td className="px-4 py-3 text-text-secondary">{event.session_id || '-'}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setExpandedEventId(expanded ? null : event.id)}
                          disabled={details.length === 0}
                          className="control-pill-btn h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          aria-expanded={expanded}
                          aria-controls={`security-event-details-${event.id}`}
                        >
                          {expanded ? 'Hide' : 'View'}
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr id={`security-event-details-${event.id}`} className="border-b border-border-subtle/50 bg-bg-secondary/50">
                        <td colSpan={7} className="px-4 py-4">
                          <dl className="space-y-3">
                            {details.map(([label, value]) => (
                              <div key={label}>
                                <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</dt>
                                <dd>
                                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-bg-primary/60 p-3 font-mono text-xs text-text-secondary">
                                    {value}
                                  </pre>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
      {(cursorStack.length > 0 || nextCursor !== null) && (
        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={goPreviousPage}
            disabled={cursorStack.length === 0}
            className="control-pill-btn h-10 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-text-muted">
            Page {pageIndex} · Showing {events.length} events
          </span>
          <button
            onClick={goNextPage}
            disabled={nextCursor === null}
            className="control-pill-btn h-10 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
