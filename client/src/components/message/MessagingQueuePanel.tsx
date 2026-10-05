import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { AccountMessagingRuntime, RuntimeQueueRow } from '../../lib/messages/accountMessagingRuntime';
import { isPreparedSend } from '../../lib/messages/durableOutbox';
import { CreamButton, ToolChip } from '../ix/primitives';
import { cn } from '../../lib/utils';

/**
 * Delivery and recovery, above the composer (docs/index-spec.md §8.4).
 *
 * Every row here is something the app is still holding on the user's behalf: a
 * send that has not landed, an edit or delete that has not been accepted, text
 * recovered from a history that is gone. Each is a quiet card (`--ix-card`, radius
 * 16) directly above the message box, at the box's width: near the composer because
 * that is where you decide what to do about them.
 *
 * The behavior is untouched: retry, copy, edit, discard and restore all go
 * through the messaging runtime exactly as before. Only the surface is Index's.
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
export const IN_FLIGHT_GRACE_MS = 1_500;

/** A send that is simply on its way, and has not been on its way for long. */
export function isQuietlyInFlight(row: RuntimeQueueRow, nowMs: number): boolean {
  if (row.record.status !== 'pending' || row.record.error) return false;
  const started = Date.parse(row.record.createdAt);
  return Number.isFinite(started) && nowMs - started < IN_FLIGHT_GRACE_MS;
}

/** One card. The shape is shared by queued sends, mutations and recovery. */
function DeliveryRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <li className={cn('ix-notice', className)}>{children}</li>;
}

function RowTitle({ children }: { children: React.ReactNode }) {
  return <p className="ix-notice__title">{children}</p>;
}

function QueueEntry({ runtime, row, copy }: { runtime: AccountMessagingRuntime; row: RuntimeQueueRow; copy: (content: string) => void }) {
  const [editing, setEditing] = useState(false);
  const editRow = useRef<RuntimeQueueRow | null>(null);
  const [content, setContent] = useState(row.record.draft.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepared = isPreparedSend(row.record);
  const discarding = prepared && row.record.mutation?.kind === 'discard';
  /**
   * The server *refused* this message — an AutoMod block, a permission that is
   * gone, a body it will not accept — rather than failing to take it.
   *
   * Two of this row's three sentences were false for a refusal: "Retry
   * delivery" offered an attempt that would be refused identically forever,
   * and the prepared-send note said the delivery "may already have committed"
   * when a refusal is proof it did not. A refusal is terminal, so the row says
   * so and offers the two things that can actually resolve it.
   */
  const refused = Boolean(row.record.refused) && !discarding;
  async function act(action: 'retry' | 'discard' | 'edit') {
    setBusy(true); setError(null);
    try { await runtime.queueAction(action === 'edit' ? editRow.current ?? row : row, action, content); setEditing(false); }
    catch (error) { setError(error instanceof Error ? error.message : 'The queued message could not be changed.'); }
    finally { setBusy(false); }
  }
  return <DeliveryRow>
    <RowTitle>{discarding ? 'Resolving discard' : refused ? 'Refused — not delivered' : row.record.status === 'failed' ? 'Delivery needs attention' : 'Queued message'}</RowTitle>
    <p className="ix-notice__text">{row.record.draft.content || 'Attachment or sticker message'}</p>
    {row.record.error && <p className="ix-notice__fine">{row.record.error}</p>}
    {refused
      ? <p className="ix-notice__fine">Sending this again would be refused the same way. Change the message and it goes back in the queue, or discard it.</p>
      : prepared && <p className="ix-notice__fine">Delivery may already have committed. Editing or discarding resolves the original request first.</p>}
    {editing && <label className="ix-notice__field">Replacement text
      <textarea
        value={content}
        onChange={event => setContent(event.target.value)}
        disabled={busy}
        rows={3}
      />
    </label>}
    <div className="ix-notice__acts">
      {editing ? <>
        <CreamButton size="sm" disabled={busy || !content.trim()} onClick={() => void act('edit')}>Save queued edit</CreamButton>
        <ToolChip disabled={busy} onClick={() => setEditing(false)}>Cancel edit</ToolChip>
      </> : <>
        {!refused && <ToolChip disabled={busy} onClick={() => void act('retry')}>Retry delivery</ToolChip>}
        <ToolChip disabled={!row.record.draft.content} onClick={() => copy(row.record.draft.content)}>Copy text</ToolChip>
        <ToolChip disabled={busy || discarding} onClick={() => { editRow.current = row; setContent(row.record.draft.content); setEditing(true); }}>Edit queued text</ToolChip>
        <ToolChip disabled={busy || discarding} onClick={() => void act('discard')}>{prepared && !refused ? 'Resolve and discard' : 'Discard draft'}</ToolChip>
      </>}
    </div>
    {error && <p role="alert" className="ix-notice__error">{error}</p>}
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
  return <details className="ix-notice-group" open>
    <summary className="ix-notice-summary">Saved delivery and recovery ({rows.length + mutations.length + recovery.length})</summary>
    <ul className="ix-notice-list">
      {rows.map(row => <QueueEntry key={`${row.source}:${row.record.id}`} runtime={runtime} row={row} copy={content => void copy(content)} />)}
      {mutations.map(row => <DeliveryRow key={`${row.source}:${row.record.id}`}>
        <RowTitle>{row.record.intent.kind === 'delete' ? 'Saved deletion' : 'Saved message edit'}</RowTitle>
        {row.record.draft && <p className="ix-notice__text">{row.record.draft.content}</p>}
        {row.record.error && <p className="ix-notice__fine">{row.record.error}</p>}
        <div className="ix-notice__acts">
          {!row.record.targetDeleted && <ToolChip onClick={() => void runtime.retryMutation(row).catch(error => setError(error instanceof Error ? error.message : 'Retry failed.'))}>Retry saved change</ToolChip>}
          {row.record.draft && <ToolChip onClick={() => void copy(row.record.draft!.content)}>Copy retained text</ToolChip>}
        </div>
      </DeliveryRow>)}
      {recovery.map(row => <DeliveryRow key={row.id}>
        <RowTitle>Recovery draft</RowTitle>
        <p className="ix-notice__text">{row.content}</p>
        <p className="ix-notice__fine">{row.reason}</p>
        <div className="ix-notice__acts">
          <ToolChip onClick={() => void restore(row.content)}>Restore into the composer</ToolChip>
          <ToolChip onClick={() => void copy(row.content)}>Copy recovery text</ToolChip>
        </div>
      </DeliveryRow>)}
    </ul>
    {error && <p role="alert" className="ix-notice__error">{error}</p>}
  </details>;
}
