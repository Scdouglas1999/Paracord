import { Fragment, useState, useEffect } from 'react';
import { RotateCw, ShieldCheck } from 'lucide-react';
import { adminApi, type SecurityEvent } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import {
  Button,
  EmptyState,
  LoadingSpinner,
  SettingsSectionHeader,
  TextField,
  Well,
} from '../../components/ui';

/** A blank audit field says what is missing, not "—" (§6.9). */
function Field({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-meta text-text-faint">not recorded</span>;
  return <span className="pc-mono text-meta text-text-secondary">{value}</span>;
}

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
    let canceled = false;
    const fetchEvents = async () => {
      setLoading(true);
      try {
        const { data } = await adminApi.listSecurityEvents({
          limit: pageLimit + 1,
          before: cursor ?? undefined,
          action: appliedAction || undefined,
        });
        if (canceled) return;
        const pageEvents = data.slice(0, pageLimit);
        setEvents(pageEvents);
        setNextCursor(data.length > pageLimit && pageEvents.length > 0
          ? pageEvents[pageEvents.length - 1].id
          : null);
        setExpandedEventId(null);
      } catch (err) {
        if (!canceled) {
          toast.error(`Failed to load security events: ${extractApiError(err)}`);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    };
    void fetchEvents();
    return () => {
      canceled = true;
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
      <SettingsSectionHeader
        title="Security events"
        description="Authentication and administrative activity, newest first."
        action={
          <Button
            variant="ghost"
            onClick={() => setReloadKey((key) => key + 1)}
            className="gap-2"
          >
            <RotateCw size={15} />
            Refresh
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-2">
        <TextField
          id="admin-security-action-filter"
          label="Filter security events by exact action"
          hideLabel
          type="text"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyFilter()}
          placeholder="Exact action, e.g. auth.login"
          className="w-[min(20rem,100%)]"
        />
        <Button onClick={applyFilter}>Apply</Button>
      </div>

      {loading ? (
        <Well className="px-6 py-10">
          <LoadingSpinner size="sm" label="Loading security events…" />
        </Well>
      ) : events.length === 0 ? (
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
                variant="ghost"
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
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left">
            <thead>
              <tr>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Time</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Action</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Actor</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Target</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">IP</th>
                <th scope="col" className="px-3 pb-2 text-section text-text-faint">Session</th>
                <th scope="col" className="px-3 pb-2 text-right text-section text-text-faint">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const details = formatDetails(event);
                const expanded = expandedEventId === event.id;
                return (
                  <Fragment key={event.id}>
                    <tr className="border-t border-border-subtle align-top transition-colors hover:bg-bg-mod-subtle">
                      <td className="px-3 py-2.5">
                        <span className="pc-mono text-meta tabular-nums text-text-secondary">
                          {new Date(event.created_at).toLocaleString()}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="pc-mono inline-flex items-center rounded-[var(--radius-chip)] bg-bg-raised px-2 py-0.5 text-meta text-text-primary shadow-[var(--shadow-chip)]">
                          {event.action}
                        </span>
                      </td>
                      <td className="px-3 py-2.5"><Field value={event.actor_user_id} /></td>
                      <td className="px-3 py-2.5"><Field value={event.target_user_id} /></td>
                      <td className="px-3 py-2.5"><Field value={event.ip_address} /></td>
                      <td className="px-3 py-2.5"><Field value={event.session_id} /></td>
                      <td className="px-3 py-2.5 text-right">
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
                      <tr id={`security-event-details-${event.id}`} className="border-t border-border-subtle">
                        <td colSpan={7} className="px-3 py-3">
                          <dl className="flex flex-col gap-3">
                            {details.map(([label, value]) => (
                              <div key={label}>
                                <dt className="mb-1 text-section text-text-faint">{label}</dt>
                                <dd>
                                  <Well
                                    as="div"
                                    bare
                                    className="max-h-56 overflow-auto p-3"
                                  >
                                    <pre className="pc-mono whitespace-pre-wrap break-words text-meta text-text-secondary">
                                      {value}
                                    </pre>
                                  </Well>
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
      )}
      {(cursorStack.length > 0 || nextCursor !== null) && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={goPreviousPage} disabled={cursorStack.length === 0}>
            Previous
          </Button>
          <span className="pc-mono text-meta tabular-nums text-text-faint">
            Page {pageIndex} · {events.length} events
          </span>
          <Button variant="ghost" size="sm" onClick={goNextPage} disabled={nextCursor === null}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
