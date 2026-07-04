import { Fragment, useState, useEffect } from 'react';
import { RotateCw, ShieldCheck } from 'lucide-react';
import { adminApi, type SecurityEvent } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { EmptyState, LoadingSpinner } from '../../components/ui/Feedback';

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
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-heading text-text-primary">Security events</h2>
          <p className="mt-1 text-body text-text-secondary">
            Authentication and administrative activity, newest first.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setReloadKey((key) => key + 1)}
          className="gap-2"
        >
          <RotateCw size={15} />
          Refresh
        </Button>
      </header>

      <div className="mb-5 flex flex-wrap gap-2">
        <label htmlFor="admin-security-action-filter" className="sr-only">
          Filter security events by exact action
        </label>
        <Input
          id="admin-security-action-filter"
          type="text"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyFilter()}
          placeholder="Exact action, e.g. auth.login"
          className="max-w-xs"
        />
        <Button variant="outline" onClick={applyFilter}>Apply</Button>
      </div>

      {loading ? (
        <div className="rounded-md border border-border-subtle bg-bg-secondary px-6 py-10 shadow-sm">
          <LoadingSpinner size="sm" label="Loading security events…" />
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-md border border-border-subtle bg-bg-secondary px-4 shadow-sm">
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title={appliedAction ? `No events matched "${appliedAction}"` : 'No security events recorded yet'}
            description={
              appliedAction
                ? 'No audit entries match that exact action. Check the action name or clear the filter to see everything.'
                : 'Sign-ins, permission changes, and admin actions will show up here as they happen.'
            }
            action={
              appliedAction ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setActionFilter('');
                    setAppliedAction('');
                    setCursorStack([]);
                    setCursor(null);
                    setReloadKey((k) => k + 1);
                  }}
                >
                  Clear filter
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-tertiary/40">
                  <th scope="col" className="px-4 py-3 text-section uppercase text-text-secondary">Time</th>
                  <th scope="col" className="px-4 py-3 text-section uppercase text-text-secondary">Action</th>
                  <th scope="col" className="px-4 py-3 text-section uppercase text-text-secondary">Actor</th>
                  <th scope="col" className="px-4 py-3 text-section uppercase text-text-secondary">Target</th>
                  <th scope="col" className="px-4 py-3 text-section uppercase text-text-secondary">IP</th>
                  <th scope="col" className="px-4 py-3 text-section uppercase text-text-secondary">Session</th>
                  <th scope="col" className="px-4 py-3 text-right text-section uppercase text-text-secondary">Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const details = formatDetails(event);
                  const expanded = expandedEventId === event.id;
                  return (
                    <Fragment key={event.id}>
                      <tr className="border-b border-border-subtle/60 align-top transition-colors hover:bg-bg-mod-subtle">
                        <td className="px-4 py-3 font-code text-meta tabular-nums text-text-secondary">
                          {new Date(event.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-xs bg-bg-mod-strong px-2 py-0.5 font-code text-meta text-text-primary">
                            {event.action}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-code text-meta text-text-secondary">{event.actor_user_id || '—'}</td>
                        <td className="px-4 py-3 font-code text-meta text-text-secondary">{event.target_user_id || '—'}</td>
                        <td className="px-4 py-3 font-code text-meta text-text-secondary">{event.ip_address || '—'}</td>
                        <td className="px-4 py-3 font-code text-meta text-text-secondary">{event.session_id || '—'}</td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpandedEventId(expanded ? null : event.id)}
                            disabled={details.length === 0}
                            aria-expanded={expanded}
                            aria-controls={`security-event-details-${event.id}`}
                          >
                            {expanded ? 'Hide' : 'View'}
                          </Button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr id={`security-event-details-${event.id}`} className="border-b border-border-subtle/60 bg-bg-tertiary/40">
                          <td colSpan={7} className="px-4 py-4">
                            <dl className="space-y-3">
                              {details.map(([label, value]) => (
                                <div key={label}>
                                  <dt className="mb-1 text-section uppercase text-text-muted">{label}</dt>
                                  <dd>
                                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border-subtle bg-bg-tertiary p-3 font-code text-meta text-text-secondary">
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
          <Button variant="secondary" size="sm" onClick={goPreviousPage} disabled={cursorStack.length === 0}>
            Previous
          </Button>
          <span className="font-code text-meta tabular-nums text-text-muted">
            Page {pageIndex} · {events.length} events
          </span>
          <Button variant="secondary" size="sm" onClick={goNextPage} disabled={nextCursor === null}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
