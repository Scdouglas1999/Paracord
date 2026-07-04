import { useEffect, useMemo, useState } from 'react';
import { Clock3, Pencil, Trash2 } from 'lucide-react';
import { channelApi, type ScheduledMessage } from '../../api/channels';
import { useMessageStore } from '../../stores/messageStore';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';
import { extractApiError } from '../../api/client';
import { formatTimestamp, toDatetimeLocalValue } from '../../lib/formatters';
import { SCHEDULED_MESSAGE_MIN_LEAD_MS } from '../../lib/constants';
import { Modal, ModalCloseButton } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState, ErrorBanner } from '../ui/Feedback';
import { Button } from '../ui/Button';

const STATUS_SCHEDULED = 0;
const STATUS_SENT = 1;
const STATUS_CANCELLED = 2;
const STATUS_FAILED = 3;

interface ScheduledMessagesPanelProps {
  channelId: string;
  channelName?: string;
  onClose: () => void;
  /** Notifies the opener when the pending count changes (create composer badge). */
  onCountChange?: (pending: number) => void;
}

function statusLabel(status: number): string {
  switch (status) {
    case STATUS_SCHEDULED:
      return 'Scheduled';
    case STATUS_SENT:
      return 'Sent';
    case STATUS_CANCELLED:
      return 'Cancelled';
    case STATUS_FAILED:
      return 'Failed';
    default:
      return 'Unknown';
  }
}


export function ScheduledMessagesPanel({
  channelId,
  channelName,
  onClose,
  onCountChange,
}: ScheduledMessagesPanelProps) {
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editSendAt, setEditSendAt] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    channelApi
      .listScheduledMessages(channelId)
      .then(({ data }) => {
        if (cancelled) return;
        setItems(data);
        onCountChange?.(data.filter((m) => m.status === STATUS_SCHEDULED).length);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(extractApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, onCountChange]);

  const emitCount = (next: ScheduledMessage[]) => {
    onCountChange?.(next.filter((m) => m.status === STATUS_SCHEDULED).length);
  };

  const beginEdit = (item: ScheduledMessage) => {
    setEditingId(item.id);
    setEditContent(item.content ?? '');
    setEditSendAt(toDatetimeLocalValue(item.send_at));
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent('');
    setEditSendAt('');
    setEditError(null);
  };

  const saveEdit = async (id: string) => {
    const trimmed = editContent.trim();
    if (!trimmed) {
      setEditError('Enter a message.');
      return;
    }
    if (!editSendAt) {
      setEditError('Select when this message should be sent.');
      return;
    }
    const parsed = new Date(editSendAt);
    if (Number.isNaN(parsed.getTime())) {
      setEditError('Select a valid scheduled time.');
      return;
    }
    if (parsed.getTime() < Date.now() + SCHEDULED_MESSAGE_MIN_LEAD_MS) {
      setEditError('Choose a time at least 5 seconds in the future.');
      return;
    }
    setEditError(null);
    setSavingId(id);
    try {
      const sendAtIso = parsed.toISOString();
      await useMessageStore.getState().editScheduledMessage(channelId, id, trimmed, sendAtIso);
      setItems((prev) => {
        const next = prev.map((m) =>
          m.id === id
            ? { ...m, content: trimmed, send_at: sendAtIso, status: STATUS_SCHEDULED }
            : m,
        );
        emitCount(next);
        return next;
      });
      cancelEdit();
      toast.success('Scheduled message updated.');
    } catch (err) {
      setEditError(extractApiError(err));
    } finally {
      setSavingId(null);
    }
  };

  const removeItem = async (item: ScheduledMessage) => {
    const confirmed = await confirm({
      title: 'Cancel scheduled message?',
      description: 'This scheduled message will not be sent.',
      confirmLabel: 'Cancel message',
      cancelLabel: 'Keep',
      variant: 'danger',
    });
    if (!confirmed) return;
    setDeletingId(item.id);
    try {
      await channelApi.deleteScheduledMessage(channelId, item.id);
      setItems((prev) => {
        const next = prev.filter((m) => m.id !== item.id);
        emitCount(next);
        return next;
      });
      if (editingId === item.id) cancelEdit();
      toast.success('Scheduled message cancelled.');
    } catch (err) {
      toast.error(`Failed to cancel scheduled message: ${extractApiError(err)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const sorted = useMemo(
    () => [...items].sort((a, b) => new Date(a.send_at).getTime() - new Date(b.send_at).getTime()),
    [items],
  );

  const minSendAt = toDatetimeLocalValue(Date.now() + SCHEDULED_MESSAGE_MIN_LEAD_MS);

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="scheduled-messages-title"
      size="auto"
      panelClassName="max-h-[min(86dvh,44rem)] w-[min(92vw,34rem)] overflow-auto"
    >
      <ModalCloseButton className="right-3 top-3 sm:right-4 sm:top-4" />
      <div className="px-6 pb-4 pt-6 sm:px-7 sm:pt-7">
          <div className="flex items-center gap-2">
            <Clock3 size={18} className="text-accent-primary" />
            <h2
              id="scheduled-messages-title"
              className="text-title text-text-primary"
            >
              Scheduled messages
            </h2>
          </div>
          <p className="mt-1 text-label text-text-secondary">
            {channelName ? `#${channelName}` : 'This channel'}
          </p>
        </div>

        <div className="px-6 pb-6 sm:px-7 sm:pb-7">
          {loading && (
            <div className="flex flex-col" aria-busy="true" aria-label="Loading scheduled messages">
              {[0, 1, 2].map((i) => (
                <div key={i} className="border-t border-border-subtle py-3 first:border-t-0 first:pt-1">
                  <Skeleton width="42%" height={12} borderRadius="var(--radius-xs)" />
                  <div className="mt-2.5">
                    <Skeleton width="85%" height={14} borderRadius="var(--radius-xs)" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && loadError && (
            <ErrorBanner message={loadError} />
          )}

          {!loading && !loadError && sorted.length === 0 && (
            <EmptyState
              icon={<Clock3 size={20} />}
              title="Nothing scheduled"
              description="No messages scheduled — pick a time in the composer to queue one, and it'll send itself even while you're away."
              action={<Button onClick={onClose}>Back to composer</Button>}
            />
          )}

          {!loading && !loadError && sorted.length > 0 && (
            <div className="flex flex-col">
            {sorted.map((item) => {
              const isEditing = editingId === item.id;
              const isPending = item.status === STATUS_SCHEDULED;
              return (
                <div
                  key={item.id}
                  className="group border-t border-border-subtle py-3 first:border-t-0 first:pt-1"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-section uppercase text-text-secondary">
                        <span>{statusLabel(item.status)}</span>
                        <span aria-hidden>·</span>
                        <span className="font-code normal-case tabular-nums tracking-normal text-text-muted">
                          {formatTimestamp(item.send_at)}
                        </span>
                      </div>
                      {item.status === STATUS_FAILED && item.error && (
                        <p className="mt-1 text-meta text-accent-danger">{item.error}</p>
                      )}
                    </div>
                    {isPending && !isEditing && (
                      <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity duration-[140ms] ease-[var(--ease-out)] group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => beginEdit(item)}
                          className="icon-btn h-7 w-7"
                          aria-label="Edit scheduled message"
                          title="Edit"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeItem(item)}
                          disabled={deletingId === item.id}
                          className="icon-btn h-7 w-7 text-accent-danger"
                          aria-label="Cancel scheduled message"
                          title="Cancel"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}
                  </div>

                  {isEditing ? (
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="input-field min-h-[64px] resize-y"
                        aria-label="Scheduled message content"
                      />
                      <label className="block">
                        <span className="text-section uppercase text-text-secondary">
                          Send at
                        </span>
                        <input
                          type="datetime-local"
                          value={editSendAt}
                          onChange={(e) => setEditSendAt(e.target.value)}
                          className="input-field mt-1.5"
                          min={minSendAt}
                          aria-label="Scheduled send time"
                        />
                      </label>
                      {editError && (
                        <div
                          role="alert"
                          className="rounded-sm border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-meta font-semibold text-accent-danger"
                        >
                          {editError}
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="btn-secondary px-3 py-1.5 text-label"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => saveEdit(item.id)}
                          disabled={savingId === item.id}
                          className="btn-primary px-3 py-1.5 text-label"
                        >
                          {savingId === item.id ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-body text-text-primary">
                      {item.content || <span className="italic text-text-muted">Attachment only</span>}
                    </p>
                  )}
                </div>
              );
            })}
            </div>
          )}
        </div>
    </Modal>
  );
}
