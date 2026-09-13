import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { AccountMessagingRuntime, RuntimeQueueRow } from '../../lib/messages/accountMessagingRuntime';
import { isPreparedSend } from '../../lib/messages/durableOutbox';

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
  return <li className="min-w-0 rounded-lg border border-[var(--border-subtle)] p-3">
    <p className="text-sm font-medium">{discarding ? 'Resolving discard' : row.record.status === 'failed' ? 'Delivery needs attention' : 'Queued message'}</p>
    <p className="mt-1 whitespace-pre-wrap break-words text-sm">{row.record.draft.content || 'Attachment or sticker message'}</p>
    {row.record.error && <p className="mt-2 break-words text-sm text-[var(--text-muted)]">{row.record.error}</p>}
    {prepared && <p className="mt-1 text-xs text-[var(--text-muted)]">Delivery may already have committed. Editing or discarding resolves the original request first.</p>}
    {editing && <label className="mt-2 block text-sm">Replacement text
      <textarea className="input-field mt-1 w-full" value={content} onChange={event => setContent(event.target.value)} disabled={busy} rows={3} />
    </label>}
    <div className="mt-2 flex flex-wrap gap-2">
      {editing ? <>
        <button className="btn-primary" disabled={busy || !content.trim()} onClick={() => void act('edit')}>Save queued edit</button>
        <button className="btn-ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel edit</button>
      </> : <>
        <button className="btn-ghost" disabled={busy} onClick={() => void act('retry')}>Retry delivery</button>
        <button className="btn-ghost" disabled={!row.record.draft.content} onClick={() => copy(row.record.draft.content)}>Copy text</button>
        <button className="btn-ghost" disabled={busy || discarding} onClick={() => { editRow.current = row; setContent(row.record.draft.content); setEditing(true); }}>Edit queued text</button>
        <button className="btn-ghost" disabled={busy || discarding} onClick={() => void act('discard')}>{prepared ? 'Resolve and discard' : 'Discard draft'}</button>
      </>}
    </div>
    {error && <p role="alert" className="mt-2 break-words text-sm text-[var(--text-danger)]">{error}</p>}
  </li>;
}

/** Delivery and recovery belong to the visible account and conversation. */
export function MessagingQueuePanel({ runtime, channelId }: { runtime: AccountMessagingRuntime; channelId: string }) {
  const snapshot = useStore(runtime.store);
  const [error, setError] = useState<string | null>(null);
  const rows = snapshot.queue.filter(row => row.record.channelId === channelId);
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
  return <details className="min-w-0 border-t border-[var(--border-subtle)] p-3" open>
    <summary className="cursor-pointer text-sm font-medium">Saved delivery and recovery ({rows.length + mutations.length + recovery.length})</summary>
    <ul className="mt-3 space-y-2">
      {rows.map(row => <QueueEntry key={`${row.source}:${row.record.id}`} runtime={runtime} row={row} copy={content => void copy(content)} />)}
      {mutations.map(row => <li key={`${row.source}:${row.record.id}`} className="min-w-0 rounded-lg border border-[var(--border-subtle)] p-3">
        <p className="text-sm font-medium">{row.record.intent.kind === 'delete' ? 'Saved deletion' : 'Saved message edit'}</p>
        {row.record.draft && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{row.record.draft.content}</p>}
        {row.record.error && <p className="mt-2 break-words text-sm text-[var(--text-muted)]">{row.record.error}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {!row.record.targetDeleted && <button className="btn-ghost" onClick={() => void runtime.retryMutation(row).catch(error => setError(error instanceof Error ? error.message : 'Retry failed.'))}>Retry saved change</button>}
          {row.record.draft && <button className="btn-ghost" onClick={() => void copy(row.record.draft!.content)}>Copy retained text</button>}
        </div>
      </li>)}
      {recovery.map(row => <li key={row.id} className="min-w-0 rounded-lg border border-[var(--border-subtle)] p-3">
        <p className="text-sm font-medium">Recovery draft</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{row.content}</p>
        <p className="mt-2 break-words text-xs text-[var(--text-muted)]">{row.reason}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={() => void restore(row.content)}>Restore into the composer</button>
          <button className="btn-ghost" onClick={() => void copy(row.content)}>Copy recovery text</button>
        </div>
      </li>)}
    </ul>
    {error && <p role="alert" className="mt-2 break-words text-sm text-[var(--text-danger)]">{error}</p>}
  </details>;
}
