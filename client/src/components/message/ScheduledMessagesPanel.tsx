import { useEffect, useMemo, useState } from 'react';
import { channelApi, type ScheduledMessage } from '../../api/channels';
import { useCurrentMessageStoreApi } from '../../hooks/useMessageStore';
import { toast } from '../../stores/toastStore';
import { confirm } from '../../stores/confirmStore';
import { extractApiError } from '../../api/client';
import { formatTimestamp, toDatetimeLocalValue } from '../../lib/formatters';
import { SCHEDULED_MESSAGE_MIN_LEAD_MS } from '../../lib/constants';
import { SheetFrame } from '../glass/sheets/SheetFrame';
import { SheetEmpty } from '../glass/sheets/SheetParts';
import { GlyphFrame, IxGlyph } from '../ix/glyphs';
import { CreamButton } from '../ix/primitives';

const STATUS_SCHEDULED = 0;
const STATUS_SENT = 1;
const STATUS_CANCELED = 2;
const STATUS_FAILED = 3;

interface ScheduledMessagesPanelProps {
  /** The sheet is showing. It loads the list each time it opens. */
  open: boolean;
  channelId: string;
  channelName?: string;
  onClose: () => void;
  /** Notifies the opener when the pending count changes (the Send menu's count). */
  onCountChange?: (pending: number) => void;
}

function statusLabel(status: number): string {
  switch (status) {
    case STATUS_SCHEDULED:
      return 'Scheduled';
    case STATUS_SENT:
      return 'Sent';
    case STATUS_CANCELED:
      return 'Canceled';
    case STATUS_FAILED:
      return 'Failed';
    default:
      return 'Unknown';
  }
}

function ClockGlyph({ size = 20 }: { size?: number }) {
  return (
    <GlyphFrame size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </GlyphFrame>
  );
}

/**
 * Scheduled messages (docs/index-spec.md §8.4; WP IX-12): the sheet the Send
 * control's menu opens ("Scheduled messages"), inside main on its right like
 * every sheet (§6.1). Each pending message can be changed (its words and its
 * time) or canceled; sent, canceled and failed ones stay listed with their
 * state.
 */
export function ScheduledMessagesPanel({
  open,
  channelId,
  channelName,
  onClose,
  onCountChange,
}: ScheduledMessagesPanelProps) {
  const messageStore = useCurrentMessageStoreApi();
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
    if (!open) return;
    let canceled = false;
    setLoading(true);
    setLoadError(null);
    channelApi
      .listScheduledMessages(channelId)
      .then(({ data }) => {
        if (canceled) return;
        setItems(data);
        onCountChange?.(data.filter((m) => m.status === STATUS_SCHEDULED).length);
      })
      .catch((err) => {
        if (canceled) return;
        setLoadError(extractApiError(err));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [open, channelId, onCountChange]);

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
      await messageStore.getState().editScheduledMessage(channelId, id, trimmed, sendAtIso);
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
      toast.success('Scheduled message canceled.');
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

  // Only a message being changed has a time field to bound.
  const minSendAt = editingId ? toDatetimeLocalValue(Date.now() + SCHEDULED_MESSAGE_MIN_LEAD_MS) : undefined;

  return (
    <SheetFrame
      open={open}
      onClose={onClose}
      kind="scheduled"
      label="Scheduled messages"
      title="Scheduled messages"
      subtitle={channelName ?? 'This conversation'}
      closeLabel="Close scheduled messages"
    >
      {loading && (
        <div className="ix-scheduled" aria-busy="true" aria-label="Loading scheduled messages">
          {[0, 1, 2].map((i) => (
            <div key={i} className="ix-scheduled__item ix-scheduled__item--skeleton">
              <span className="ix-scheduled__bar" />
              <span className="ix-scheduled__bar ix-scheduled__bar--long" />
            </div>
          ))}
        </div>
      )}

      {!loading && loadError && (
        <div role="alert" className="ix-scheduled__alert">
          <span>Scheduled messages did not load: {loadError}</span>
        </div>
      )}

      {!loading && !loadError && sorted.length === 0 && (
        <SheetEmpty icon={<ClockGlyph />} title="Nothing scheduled">
          Right-click or hold Send, then choose Send later to pick a time. It goes out on its own, even while you are away.
        </SheetEmpty>
      )}

      {!loading && !loadError && sorted.length > 0 && (
        <ul className="ix-scheduled">
          {sorted.map((item) => {
            const isEditing = editingId === item.id;
            const isPending = item.status === STATUS_SCHEDULED;
            return (
              <li key={item.id} className="ix-scheduled__item" data-status={statusLabel(item.status).toLowerCase()}>
                <div className="ix-scheduled__head">
                  <span className="ix-scheduled__when">
                    <span className="ix-scheduled__state">{statusLabel(item.status)}</span>
                    <span aria-hidden>·</span>
                    <time dateTime={item.send_at}>{formatTimestamp(item.send_at)}</time>
                  </span>
                  {isPending && !isEditing && (
                    <span className="ix-scheduled__actions">
                      <button
                        type="button"
                        onClick={() => beginEdit(item)}
                        className="ix-scheduled__btn"
                        aria-label="Edit scheduled message"
                        title="Edit"
                      >
                        <GlyphFrame size={15}>
                          <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />
                        </GlyphFrame>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeItem(item)}
                        disabled={deletingId === item.id}
                        className="ix-scheduled__btn ix-scheduled__btn--danger"
                        aria-label="Cancel scheduled message"
                        title="Cancel"
                      >
                        <IxGlyph name="x" size={15} />
                      </button>
                    </span>
                  )}
                </div>
                {item.status === STATUS_FAILED && item.error && (
                  <p className="ix-scheduled__error">{item.error}</p>
                )}

                {isEditing ? (
                  <div className="ix-scheduled__edit">
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="ix-scheduled__input ix-scheduled__input--text"
                      aria-label="Scheduled message content"
                    />
                    <label className="ix-scheduled__field">
                      <span>Send at</span>
                      <input
                        type="datetime-local"
                        value={editSendAt}
                        onChange={(e) => setEditSendAt(e.target.value)}
                        className="ix-scheduled__input"
                        min={minSendAt}
                        aria-label="Scheduled send time"
                      />
                    </label>
                    {editError && (
                      <p role="alert" className="ix-scheduled__error">
                        {editError}
                      </p>
                    )}
                    <div className="ix-scheduled__edit-actions">
                      <button type="button" onClick={cancelEdit} className="ix-scheduled__text-btn">
                        Cancel
                      </button>
                      <CreamButton size="sm" onClick={() => saveEdit(item.id)} disabled={savingId === item.id}>
                        {savingId === item.id ? 'Saving…' : 'Save'}
                      </CreamButton>
                    </div>
                  </div>
                ) : (
                  <p className="ix-scheduled__text">
                    {item.content || <span className="ix-scheduled__muted">Attachment only</span>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SheetFrame>
  );
}
