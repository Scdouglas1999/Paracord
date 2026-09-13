import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { AccountMessagingRuntime, RuntimeQueueRow } from '../../lib/messages/accountMessagingRuntime';
import { isPreparedSend } from '../../lib/messages/durableOutbox';
import { Button } from '../ui';
import { cn } from '../../lib/utils';

/**
 * Delivery and recovery, above the composer (docs/lantern-stage-spec.md §7.4).
 *
 * Every row here is something the app is still holding on the user's behalf: a
 * send that has not landed, an edit or delete that has not been accepted, text
 * recovered from a history that is gone. They are **raised rows inside the text
 * room's plate** — near the composer because that is where you decide what to
 * do about them, and raised because they are waiting on you.
 *
 * The behaviour is untouched: retry, copy, edit, discard and restore all go
 * through the messaging runtime exactly as before.
 *
 * One thing IS held back: a send that is merely in flight. Every send spends a
 * moment in this queue on its way to the server, and surfacing a card for it
 * meant the composer and the whole timeline were shoved down and back up again
 * in the ~200ms it took — a 180px reflow in the middle of §5.1's "a message has
 * mass", which is exactly the layout animation §5.3 forbids. A send is only
 * something you need to decide about once it has been waiting a while, so a
 * pending row with no error waits `IN_FLIGHT_GRACE_MS` before it appears.
 * Nothing else waits: a failure, a prepared/discard resolution, a saved edit or
 * deletion and a recovery draft all show the instant they exist.
 */

/**
 * How long a send may be in flight before it is worth a card. Long enough that
 * an ordinary send never draws one, short enough that a stuck one still tells
 * you before you wonder.
 */
const IN_FLIGHT_GRACE_MS = 1_500;

/** A send that is simply on its way, and has not been on its way for long. */
function isQuietlyInFlight(row: RuntimeQueueRow, nowMs: number): boolean {
  if (row.record.status !== 'pending' || row.record.error) return false;
  const started = Date.parse(row.record.createdAt);
  return Number.isFinite(started) && nowMs - started < IN_FLIGHT_GRACE_MS;
}

/** One raised row. The shape is shared by queued sends, mutations and recovery. */
function DeliveryRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        'min-w-0 rounded-[var(--radius-well)] bg-bg-raised p-3 shadow-[var(--shadow-raised)]',
        className,
      )}
    >
      {children}
    </li>
  );
}

function RowTitle({ children }: { children: React.ReactNode }) {
  return <p className="pc-display text-name text-text-primary">{children}</p>;
}

function QueueEntry({ runtime, row, copy }: { runtime: AccountMessagingRuntime; row: RuntimeQueueRow; copy: (content: string) => void }) {
  const [editing, setEditing] = useState(false);
  const editRow = useRef<RuntimeQueueRow | null>(null);
  const [content, setContent] = useState(row.record.draft.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepared = isPreparedSend(row.record);
  const discarding = prepared && row.record.mutation?.kind === 'discard';
  async function act(action: 'retry' | 'discard' | 'edit') {
    setBusy(true); setError(null);
    try { await runtime.queueAction(action === 'edit' ? editRow.current ?? row : row, action, content); setEditing(false); }
    catch (error) { setError(error instanceof Error ? error.message : 'The queued message could not be changed.'); }
    finally { setBusy(false); }
  }
  return <DeliveryRow>
    <RowTitle>{discarding ? 'Resolving discard' : row.record.status === 'failed' ? 'Delivery needs attention' : 'Queued message'}</RowTitle>
    <p className="mt-1 whitespace-pre-wrap break-words text-body text-text-body">{row.record.draft.content || 'Attachment or sticker message'}</p>
    {row.record.error && <p className="mt-2 break-words text-meta text-text-muted">{row.record.error}</p>}
    {prepared && <p className="mt-1 break-words text-meta text-text-faint">Delivery may already have committed. Editing or discarding resolves the original request first.</p>}
    {editing && <label className="mt-2 block text-meta text-text-secondary">Replacement text
      <textarea
        className="mt-1 w-full resize-y rounded-[var(--radius-well)] bg-bg-well px-3 py-2 text-body text-text-primary shadow-[var(--shadow-well)] outline-none focus-visible:shadow-[var(--focus-ring-input)]"
        value={content}
        onChange={event => setContent(event.target.value)}
        disabled={busy}
        rows={3}
      />
    </label>}
    <div className="mt-2 flex flex-wrap gap-2">
      {editing ? <>
        <Button size="sm" disabled={busy || !content.trim()} onClick={() => void act('edit')}>Save queued edit</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>Cancel edit</Button>
      </> : <>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act('retry')}>Retry delivery</Button>
        <Button variant="ghost" size="sm" disabled={!row.record.draft.content} onClick={() => copy(row.record.draft.content)}>Copy text</Button>
        <Button variant="ghost" size="sm" disabled={busy || discarding} onClick={() => { editRow.current = row; setContent(row.record.draft.content); setEditing(true); }}>Edit queued text</Button>
        <Button variant="ghost" size="sm" disabled={busy || discarding} onClick={() => void act('discard')}>{prepared ? 'Resolve and discard' : 'Discard draft'}</Button>
      </>}
    </div>
    {error && <p role="alert" className="mt-2 break-words text-meta text-accent-danger">{error}</p>}
  </DeliveryRow>;
}

/** Delivery and recovery belong to the visible account and conversation. */
export function MessagingQueuePanel({ runtime, channelId }: { runtime: AccountMessagingRuntime; channelId: string }) {
  const snapshot = useStore(runtime.store);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a held send crosses the grace period, so it appears on its own.
  const [, setGraceTick] = useState(0);
  const queued = snapshot.queue.filter(row => row.record.channelId === channelId);
  const now = Date.now();
  const rows = queued.filter(row => !isQuietlyInFlight(row, now));
  const held = queued.filter(row => isQuietlyInFlight(row, now));
  const nextDeadline = held.reduce(
    (soonest, row) => Math.min(soonest, Date.parse(row.record.createdAt) + IN_FLIGHT_GRACE_MS),
    Number.POSITIVE_INFINITY,
  );

  useEffect(() => {
    if (!Number.isFinite(nextDeadline)) return;
    const timer = window.setTimeout(() => setGraceTick(tick => tick + 1), Math.max(0, nextDeadline - Date.now()) + 16);
    return () => window.clearTimeout(timer);
  }, [nextDeadline]);

  const mutations = snapshot.mutations.filter(row => row.record.target.channelId === channelId);
  const recovery = snapshot.recovery.filter(row => row.channelId === channelId);
  if (!rows.length && !mutations.length && !recovery.length) return null;
  const copy = async (content: string) => {
    try { await navigator.clipboard.writeText(content); setError(null); }
    catch { setError('The clipboard is unavailable. Select and copy the retained text.'); }
  };
  /** Recovered text returns to the composer only through a deliberate action,
   *  and never overwrites what is already typed there. */
  const restore = async (content: string) => {
    const controller = runtime.draftController(channelId);
    if (controller.store.getState().draft.content.trim()) {
      setError('Clear this conversation’s draft before restoring recovered text, or copy it instead.');
      return;
    }
    controller.setContent(content);
    try { await controller.capture(); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : 'The recovered text could not be saved as a draft.'); }
  };
  return <details className="min-w-0" open>
    <summary className="cursor-pointer text-section text-text-secondary">Saved delivery and recovery ({rows.length + mutations.length + recovery.length})</summary>
    <ul className="mt-2 flex flex-col gap-2">
      {rows.map(row => <QueueEntry key={`${row.source}:${row.record.id}`} runtime={runtime} row={row} copy={content => void copy(content)} />)}
      {mutations.map(row => <DeliveryRow key={`${row.source}:${row.record.id}`}>
        <RowTitle>{row.record.intent.kind === 'delete' ? 'Saved deletion' : 'Saved message edit'}</RowTitle>
        {row.record.draft && <p className="mt-1 whitespace-pre-wrap break-words text-body text-text-body">{row.record.draft.content}</p>}
        {row.record.error && <p className="mt-2 break-words text-meta text-text-muted">{row.record.error}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {!row.record.targetDeleted && <Button variant="ghost" size="sm" onClick={() => void runtime.retryMutation(row).catch(error => setError(error instanceof Error ? error.message : 'Retry failed.'))}>Retry saved change</Button>}
          {row.record.draft && <Button variant="ghost" size="sm" onClick={() => void copy(row.record.draft!.content)}>Copy retained text</Button>}
        </div>
      </DeliveryRow>)}
      {recovery.map(row => <DeliveryRow key={row.id}>
        <RowTitle>Recovery draft</RowTitle>
        <p className="mt-1 whitespace-pre-wrap break-words text-body text-text-body">{row.content}</p>
        <p className="mt-2 break-words text-meta text-text-faint">{row.reason}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => void restore(row.content)}>Restore into the composer</Button>
          <Button variant="ghost" size="sm" onClick={() => void copy(row.content)}>Copy recovery text</Button>
        </div>
      </DeliveryRow>)}
    </ul>
    {error && <p role="alert" className="mt-2 break-words text-meta text-accent-danger">{error}</p>}
  </details>;
}
