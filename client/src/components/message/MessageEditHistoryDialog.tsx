import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { createChannelApi, type MessageEditHistoryEntry } from '../../api/channels';
import { extractApiError } from '../../api/client';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { captureScopedOperation, type OperationContext } from '../../lib/operationContext';
import type { AccountScope } from '../../lib/serverScope';
import { formatTimestamp } from '../../lib/formatters';
import { LoadingSpinner } from '../ui/Feedback';

interface Props {
  scope: AccountScope | null;
  channelId: string;
  messageId: string;
  position: { x: number; y: number };
  onClose: () => void;
}

type HistoryState = { kind: 'loading' } | { kind: 'error'; message: string }
  | { kind: 'ready'; entries: MessageEditHistoryEntry[] };

function HistoryContents({ scope, channelId, messageId, onClose, onRetry }: Omit<Props, 'position'> & { onRetry: () => void }) {
  const [state, setState] = useState<HistoryState>({ kind: 'loading' });
  const serverId = scope?.serverId;
  const userId = scope?.userId;
  useEffect(() => {
    let active = true;
    let context: OperationContext | undefined;
    const expired = () => { if (active) onClose(); };
    void (async () => {
      if (!serverId || !userId) throw new Error('Sign in to this server to view message history.');
      const operation = captureScopedOperation({ serverId, userId });
      context = operation;
      operation.signal.addEventListener('abort', expired, { once: true });
      const response = await createChannelApi(() => operation.api).getEditHistory(channelId, messageId);
      if (!active || context.signal.aborted) return;
      const entries = response.data;
      if (response.status !== 200 || !Array.isArray(entries) || entries.some(entry =>
        !entry || typeof entry.id !== 'string' || !entry.id || entry.message_id !== messageId
        || typeof entry.content !== 'string' || typeof entry.edited_at !== 'string'
        || !Number.isFinite(Date.parse(entry.edited_at)))
        || new Set(entries.map(entry => entry.id)).size !== entries.length) {
        throw new Error('The server returned invalid history for this message.');
      }
      setState({ kind: 'ready', entries });
    })().catch(error => {
      if (active && !context?.signal.aborted) setState({ kind: 'error', message: extractApiError(error) });
    });
    return () => {
      active = false;
      context?.signal.removeEventListener('abort', expired);
      context?.dispose();
    };
  }, [serverId, userId, channelId, messageId, onClose]);

  if (state.kind === 'loading') return <div className="px-3 py-4"><LoadingSpinner size="sm" label="Loading earlier versions" /></div>;
  if (state.kind === 'error') return <div role="alert" className="space-y-3 px-3 py-4 text-sm">
    <p className="font-semibold text-accent-danger">Couldn’t load edit history</p>
    <p className="break-words text-text-secondary">{state.message}</p>
    <button type="button" onClick={onRetry} className="min-h-11 rounded-[var(--radius-control)] bg-bg-raised px-3 text-label font-semibold text-text-primary shadow-[var(--shadow-chip)] hover:bg-bg-mod-strong focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]">Retry</button>
  </div>;
  if (state.entries.length === 0) return <p className="px-3 py-4 text-meta text-text-muted">No earlier versions are available.</p>;
  return <div className="flex flex-col">
    {state.entries.map((entry, index) => <div key={entry.id} className="border-b border-border-subtle px-3 py-2.5 last:border-b-0">
      <div className="pc-mono mb-0.5 text-meta text-text-faint">Version {index + 1} · {formatTimestamp(entry.edited_at)}</div>
      <div className="break-words text-body leading-relaxed text-text-secondary">{entry.content}</div>
    </div>)}
  </div>;
}

function OwnedHistoryDialog({ scope, channelId, messageId, position, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useFocusTrap(dialog, true, onClose);
  return createPortal(<div className="fixed inset-0 z-[100]" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className="pc-dialog absolute max-h-[min(20rem,calc(100dvh-1rem))] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      style={{ left: `clamp(8px, ${position.x}px, calc(100vw - min(20rem, calc(100vw - 1rem)) - 8px))`,
        top: `clamp(8px, ${position.y}px, calc(100dvh - min(20rem, calc(100dvh - 1rem)) - 8px))` }}>
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle pl-3 pr-1 text-label font-semibold text-text-primary">
        <h2 id={titleId} className="pc-display py-2.5">Edit history</h2>
        <button type="button" aria-label="Close edit history" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-text-muted hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"><X size={16} /></button>
      </div>
      <HistoryContents key={attempt} scope={scope} channelId={channelId} messageId={messageId} onClose={onClose} onRetry={retry} />
    </div>
  </div>, document.body);
}

/** Remount on any ownership change so a preceding account/message never flashes. */
export function MessageEditHistoryDialog(props: Props) {
  const key = JSON.stringify([props.scope?.serverId, props.scope?.userId, props.channelId, props.messageId]);
  return <OwnedHistoryDialog key={key} {...props} />;
}
