import { useState, type RefObject } from 'react';
import { extractApiError } from '../../api/client';
import { toDatetimeLocalValue, wallClock } from '../../lib/formatters';
import { reminderChoices, reminderConfirmCopy } from '../../lib/reminders';
import { toast } from '../../stores/toastStore';
import { useReminderStore } from '../../stores/reminderStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { MenuItem, MenuLabel, Popover } from '../ui/Popover';

/** The picker opens on the next round hour, never on an empty field that only looks filled. */
function nextRoundHour(now = new Date()): string {
  const at = new Date(now);
  at.setMinutes(0, 0, 0);
  at.setHours(at.getHours() + 1);
  return toDatetimeLocalValue(at);
}

/**
 * Remind me: a few fixed times and a date/time field. Saving shows a toast
 * with Undo, which puts back whatever was there before (nothing, or the time
 * this reminder had).
 */
export function RemindMeMenu({
  anchor,
  open,
  onClose,
  channelId,
  messageId,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  channelId: string;
  messageId: string;
}) {
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState(nextRoundHour);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function close() {
    setPicking(false);
    setError(null);
    onClose();
  }

  async function save(at: Date) {
    if (Number.isNaN(at.getTime())) {
      setError('Choose a date and time.');
      return;
    }
    if (at.getTime() <= Date.now()) {
      setError('Choose a time in the future.');
      return;
    }
    const previous = useReminderStore.getState().items
      .find((item) => item.message.id === messageId && item.fired_at == null) ?? null;
    setSaving(true);
    setError(null);
    try {
      await useReminderStore.getState().save(channelId, messageId, at.toISOString());
      toast.success(reminderConfirmCopy(at), undefined, {
        label: 'Undo',
        onClick: () => {
          const store = useReminderStore.getState();
          const undo = previous && new Date(previous.remind_at).getTime() > Date.now()
            ? store.save(channelId, messageId, previous.remind_at)
            : store.remove(channelId, messageId);
          void undo.catch((err) => toast.error(`Could not undo the reminder: ${extractApiError(err)}`));
        },
      });
      close();
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover anchor={anchor} open={open} onClose={close} role="menu" label="Remind me" className="w-64 p-1">
      <MenuLabel>Remind me</MenuLabel>
      {reminderChoices().map((choice) => (
        <MenuItem
          key={choice.label}
          disabled={saving}
          trailing={choice.label.startsWith('In ') ? <span className="pc-mono">{wallClock(choice.at)}</span> : undefined}
          onClick={() => void save(choice.at)}
        >
          {choice.label}
        </MenuItem>
      ))}
      <MenuItem disabled={saving} aria-expanded={picking} onClick={() => setPicking(true)}>
        Pick a date and time…
      </MenuItem>
      {picking && (
        <form
          className="pc-enter flex flex-col gap-2 px-2 pb-2 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            void save(new Date(custom));
          }}
        >
          <Input
            type="datetime-local"
            aria-label="Date and time"
            required
            value={custom}
            min={toDatetimeLocalValue(new Date())}
            onChange={(event) => setCustom(event.target.value)}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!custom} loading={saving}>
            Set reminder
          </Button>
        </form>
      )}
      {error && <p role="alert" className="px-2 pb-1.5 pt-1 text-meta text-accent-danger">{error}</p>}
    </Popover>
  );
}
