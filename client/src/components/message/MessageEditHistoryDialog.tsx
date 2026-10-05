import { useCallback, useEffect, useId, useState } from 'react';
import { createChannelApi, type MessageEditHistoryEntry } from '../../api/channels';
import { extractApiError } from '../../api/client';
import { captureScopedOperation, type OperationContext } from '../../lib/operationContext';
import type { AccountScope } from '../../lib/serverScope';
import { formatTimestamp } from '../../lib/formatters';
import { Button } from '../ui/Button';
import { LoadingSpinner } from '../ui/Feedback';
import { Modal, ModalFooter, ModalHeader, ModalTitle } from '../ui/Modal';

interface Props {
  scope: AccountScope | null;
  channelId: string;
  messageId: string;
  /** Where the edited mark was pressed. The history is a centered dialog now (§6.12), so it is not read. */
  position?: { x: number; y: number };
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
      if (!serverId || !userId) throw new Error('Sign in to this instance to view message history.');
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
        throw new Error('The instance returned invalid history for this message.');
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

  if (state.kind === 'loading') return <div className="px-[22px] py-4"><LoadingSpinner size="sm" label="Loading earlier versions" /></div>;
  if (state.kind === 'error') return <div role="alert" className="space-y-3 px-[22px] py-4 text-[14px]">
    <p className="font-semibold text-[var(--ix-danger-ink)]">Couldn’t load edit history</p>
    <p className="break-words text-[var(--ix-ink-2)]">{state.message}</p>
    <Button variant="glass" size="sm" onClick={onRetry}>Retry</Button>
  </div>;
  if (state.entries.length === 0) return <p className="px-[22px] py-4 text-[13px] text-[var(--ix-ink-3)]">No earlier versions are available.</p>;
  return <ol className="flex flex-col gap-1.5 px-[22px] py-1">
    {state.entries.map((entry, index) => <li key={entry.id} className="rounded-[12px] bg-[var(--ix-fill-card)] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--ix-line)]">
      <div className="mb-0.5 text-[12px] font-medium tabular-nums text-[var(--ix-ink-3)]">Version {index + 1} · {formatTimestamp(entry.edited_at)}</div>
      <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.45] text-[var(--ix-ink-2)]">{entry.content}</div>
    </li>)}
  </ol>;
}

/**
 * Edit history (docs/index-spec.md §6.12): a centered card dialog, each earlier
 * version a quiet row with its time in 12 ink-3. Focus goes to the close
 * control and comes back to the edited mark on close.
 */
function OwnedHistoryDialog({ scope, channelId, messageId, onClose }: Props) {
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return <Modal open onClose={onClose} labeledBy={titleId} size="sm" showCloseButton closeLabel="Close edit history" panelClassName="flex max-h-[min(34rem,calc(100dvh-2rem))] flex-col">
    <ModalHeader className="pr-14 pb-3"><ModalTitle id={titleId}>Edit history</ModalTitle></ModalHeader>
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <HistoryContents key={attempt} scope={scope} channelId={channelId} messageId={messageId} onClose={onClose} onRetry={retry} />
    </div>
    <ModalFooter className="pt-3"><Button onClick={onClose}>Done</Button></ModalFooter>
  </Modal>;
}

/** Remount on any ownership change so a preceding account/message never flashes. */
export function MessageEditHistoryDialog(props: Props) {
  const key = JSON.stringify([props.scope?.serverId, props.scope?.userId, props.channelId, props.messageId]);
  return <OwnedHistoryDialog key={key} {...props} />;
}
