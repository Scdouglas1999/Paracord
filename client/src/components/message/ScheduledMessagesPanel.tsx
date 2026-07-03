import { useEffect, useMemo, useState } from 'react';
import { Clock3, Pencil, Trash2 } from 'lucide-react';
import { channelApi, type ScheduledMessage } from '../../api/channels';
import { useMessageStore } from '../../stores/messageStore';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';
import { extractApiError } from '../../api/client';
import { formatTimestamp } from '../../lib/formatters';
import { Modal, ModalCloseButton } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState, ErrorBanner } from '../ui/Feedback';

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

/** Converts an ISO/RFC3339 instant into a `datetime-local` input value in local time. */
function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
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
    if (parsed.getTime() <= Date.now()) {
      setEditError('Choose a future time for scheduled messages.');
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

  const minSendAt = new Date(Date.now() + 5000).toISOString().slice(0, 16);

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
              className="text-xl font-semibold text-text-primary"
            >
              Scheduled messages
            </h2>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {channelName ? `#${channelName}` : 'This channel'}
          </p>
        </div>

        <div className="space-y-3 px-6 pb-6 sm:px-7 sm:pb-7">
          {loading && (
            <div className="space-y-3" aria-busy="true" aria-label="Loading scheduled messages">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-xl border border-border-subtle bg-bg-mod-subtle px-3 py-2.5">
                  <Skeleton width="40%" height={12} borderRadius="0.25rem" />
                  <div className="mt-2">
                    <Skeleton width="85%" height={14} borderRadius="0.25rem" />
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
              icon={<Clock3 size={28} />}
              title="No scheduled messages"
              description="Messages you schedule in this channel will appear here."
            />
          )}

          {!loading &&
            !loadError &&
            sorted.map((item) => {
              const isEditing = editingId === item.id;
              const isPending = item.status === STATUS_SCHEDULED;
              return (
                <div
                  key={item.id}
                  className="border border-border-subtle bg-bg-mod-subtle px-3 py-2.5"
                  style={{ borderRadius: '12px' }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                        <span>{statusLabel(item.status)}</span>
                        <span aria-hidden>·</span>
                        <span className="normal-case">{formatTimestamp(item.send_at)}</span>
                      </div>
                      {item.status === STATUS_FAILED && item.error && (
                        <p className="mt-1 text-xs text-accent-danger">{item.error}</p>
                      )}
                    </div>
                    {isPending && !isEditing && (
                      <div className="flex flex-shrink-0 items-center gap-1">
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
                        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
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
                          className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-xs font-semibold text-accent-danger"
                        >
                          {editError}
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="btn-secondary px-3 py-1.5 text-sm"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => saveEdit(item.id)}
                          disabled={savingId === item.id}
                          className="btn-primary px-3 py-1.5 text-sm"
                        >
                          {savingId === item.id ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-text-primary">
                      {item.content || <span className="text-text-muted">(no content)</span>}
                    </p>
                  )}
                </div>
              );
            })}
        </div>
    </Modal>
  );
}
