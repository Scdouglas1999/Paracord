import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { extractApiError } from '../../../api/client';
import type { ReminderItem } from '../../../api/reminders';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { relativeTime, wallClock } from '../../../lib/formatters';
import { reminderAuthor, reminderPreviewLine } from '../../../lib/reminderNotify';
import { reminderWhen, snoozeAt } from '../../../lib/reminders';
import { toast } from '../../../stores/toastStore';
import { useReminderStore } from '../../../stores/reminderStore';
import { RemindMeMenu } from '../../message/RemindMeMenu';
import { Button } from '../../ui/Button';
import { cn } from '../../../lib/utils';

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isDue(item: ReminderItem, now: number): boolean {
  if (item.fired_at) return true;
  const at = new Date(item.remind_at).getTime();
  return Number.isFinite(at) && at <= now;
}

function ReminderRow({
  item,
  due,
  onOpen,
}: {
  item: ReminderItem;
  due: boolean;
  onOpen: (item: ReminderItem) => void;
}) {
  const scope = useCurrentAccountScope();
  const changeRef = useRef<HTMLButtonElement>(null);
  const [changing, setChanging] = useState(false);
  const [preview, setPreview] = useState<string | null>(item.preview);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const author = reminderAuthor(item);

  useEffect(() => {
    let cancelled = false;
    setPreviewError(null);
    reminderPreviewLine(scope, item)
      .then((line) => {
        if (!cancelled) setPreview(line);
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(`This message could not be read here: ${extractApiError(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [item, scope]);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toast.error(extractApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const where = item.channel.guild_id ? `#${item.channel.name ?? 'channel'}` : 'Direct message';
  const text = previewError
    ?? (preview === null ? 'Loading…' : preview || 'No text');

  return (
    <li className="group rounded-chip px-3 py-2.5 hover:bg-bg-mod-subtle focus-within:bg-bg-mod-subtle">
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="pc-focusable block w-full min-w-0 rounded-chip text-left outline-none"
      >
        <span className="flex min-w-0 items-center gap-2 text-meta text-text-muted">
          <Clock size={13} className={cn('shrink-0', due ? 'text-accent-primary' : 'text-text-muted')} aria-hidden />
          <strong className="truncate text-label text-text-primary">{author}</strong>
          <span className="truncate">in {where}</span>
          <span className={cn('ml-auto shrink-0', due && 'font-semibold text-accent-primary')}>
            {due ? `Due ${relativeTime(item.fired_at ?? item.remind_at)}` : sentenceCase(reminderWhen(new Date(item.remind_at)))}
          </span>
        </span>
        <span className={cn('mt-1 block line-clamp-2 text-label leading-5', previewError ? 'text-accent-danger' : 'text-text-secondary')}>
          {text}
        </span>
      </button>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {due ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void run(() => useReminderStore.getState().remove(item.channel.id, item.message.id))}
            >
              Done
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => useReminderStore.getState().save(item.channel.id, item.message.id, snoozeAt().toISOString()))}
            >
              Snooze 1 h
            </Button>
          </>
        ) : (
          <>
            <Button ref={changeRef} size="sm" variant="ghost" disabled={busy} onClick={() => setChanging(true)} title={`Set for ${wallClock(item.remind_at)}`}>
              Change
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => useReminderStore.getState().remove(item.channel.id, item.message.id))}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
      <RemindMeMenu
        anchor={changeRef}
        open={changing}
        onClose={() => setChanging(false)}
        channelId={item.channel.id}
        messageId={item.message.id}
      />
    </li>
  );
}

/** Inbox → Reminders: due first (Done, Snooze), then upcoming (Change, Cancel). */
export function RemindersPane({
  onOpen,
  empty,
}: {
  onOpen: (item: ReminderItem) => void;
  empty: ReactNode;
}) {
  const items = useReminderStore((state) => state.items);
  const loading = useReminderStore((state) => state.loading);
  const error = useReminderStore((state) => state.error);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void useReminderStore.getState().load(true);
    // Upcoming reminders move to "Due" while the inbox is open.
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const due = items.filter((item) => isDue(item, now))
    .sort((a, b) => (b.fired_at ?? b.remind_at).localeCompare(a.fired_at ?? a.remind_at));
  const upcoming = items.filter((item) => !isDue(item, now))
    .sort((a, b) => new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime());

  if (error && items.length === 0) {
    return (
      <div role="alert" className="m-3 rounded-well border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger">
        {error}
      </div>
    );
  }
  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 px-5 py-12 text-label text-text-muted">
        <Loader2 size={18} className="animate-spin" /> Loading reminders…
      </div>
    );
  }
  if (items.length === 0) return <>{empty}</>;

  return (
    <div className="p-2">
      {due.length > 0 && (
        <section aria-labelledby="reminders-due">
          <h3 id="reminders-due" className="px-3 pb-1 pt-2 text-meta font-semibold uppercase tracking-wide text-text-muted">Due</h3>
          <ul className="space-y-1">{due.map((item) => <ReminderRow key={item.id} item={item} due onOpen={onOpen} />)}</ul>
        </section>
      )}
      {upcoming.length > 0 && (
        <section aria-labelledby="reminders-upcoming" className={cn(due.length > 0 && 'mt-2')}>
          <h3 id="reminders-upcoming" className="px-3 pb-1 pt-2 text-meta font-semibold uppercase tracking-wide text-text-muted">Upcoming</h3>
          <ul className="space-y-1">{upcoming.map((item) => <ReminderRow key={item.id} item={item} due={false} onOpen={onOpen} />)}</ul>
        </section>
      )}
    </div>
  );
}
