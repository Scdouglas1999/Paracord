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
import { GlassButton } from '../../glass/primitives';
import { SheetAlert, SheetKicker, SheetStatus } from '../../glass/sheets/SheetParts';
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
    let canceled = false;
    setPreviewError(null);
    reminderPreviewLine(scope, item)
      .then((line) => {
        if (!canceled) setPreview(line);
      })
      .catch((err) => {
        if (!canceled) setPreviewError(`This message could not be read here: ${extractApiError(err)}`);
      });
    return () => {
      canceled = true;
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

  const where = item.channel.guild_id ? item.channel.name ?? 'channel' : 'Direct message';
  const text = previewError
    ?? (preview === null ? 'Loading…' : preview || 'No text');

  return (
    <li className="glass-sheet-card glass-reminder">
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="glass-reminder__open glass-focusable"
      >
        <span className="glass-sheet-card__head">
          <Clock size={14} className={cn('shrink-0', due ? 'text-text-primary' : 'text-text-muted')} aria-hidden />
          <span className="glass-sheet-card__author">{author}</span>
          <span className="glass-sheet-line glass-reminder__where">in {where}</span>
          <span className={cn('glass-sheet-card__when glass-instrument', due && 'glass-reminder__due')}>
            {due ? `Due ${relativeTime(item.fired_at ?? item.remind_at)}` : sentenceCase(reminderWhen(new Date(item.remind_at)))}
          </span>
        </span>
        <span className={cn('glass-sheet-card__body glass-reminder__text', previewError && 'glass-reminder__error')}>
          {text}
        </span>
      </button>
      <div className="glass-reminder__actions">
        {due ? (
          <>
            <GlassButton
              variant="text"
              disabled={busy}
              onClick={() => void run(() => useReminderStore.getState().remove(item.channel.id, item.message.id))}
            >
              Done
            </GlassButton>
            <GlassButton
              variant="text"
              disabled={busy}
              onClick={() => void run(() => useReminderStore.getState().save(item.channel.id, item.message.id, snoozeAt().toISOString()))}
            >
              Snooze 1 h
            </GlassButton>
          </>
        ) : (
          <>
            <GlassButton ref={changeRef} variant="text" disabled={busy} onClick={() => setChanging(true)} title={`Set for ${wallClock(item.remind_at)}`}>
              Change
            </GlassButton>
            <GlassButton
              variant="text"
              disabled={busy}
              onClick={() => void run(() => useReminderStore.getState().remove(item.channel.id, item.message.id))}
            >
              Cancel
            </GlassButton>
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

/** Reminders: due first (Done, Snooze), then upcoming (Change, Cancel). */
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
    // Upcoming reminders move to "Due" while this is open.
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const due = items.filter((item) => isDue(item, now))
    .sort((a, b) => (b.fired_at ?? b.remind_at).localeCompare(a.fired_at ?? a.remind_at));
  const upcoming = items.filter((item) => !isDue(item, now))
    .sort((a, b) => new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime());

  if (error && items.length === 0) return <SheetAlert>{error}</SheetAlert>;
  if (loading && items.length === 0) {
    return (
      <SheetStatus>
        <Loader2 size={16} className="animate-spin" aria-hidden /> Loading reminders…
      </SheetStatus>
    );
  }
  if (items.length === 0) return <>{empty}</>;

  return (
    <div>
      {due.length > 0 && (
        <section aria-labelledby="reminders-due">
          <SheetKicker id="reminders-due">Due</SheetKicker>
          <ul className="glass-sheet-cards">{due.map((item) => <ReminderRow key={item.id} item={item} due onOpen={onOpen} />)}</ul>
        </section>
      )}
      {upcoming.length > 0 && (
        <section aria-labelledby="reminders-upcoming">
          <SheetKicker id="reminders-upcoming">Upcoming</SheetKicker>
          <ul className="glass-sheet-cards">{upcoming.map((item) => <ReminderRow key={item.id} item={item} due={false} onOpen={onOpen} />)}</ul>
        </section>
      )}
    </div>
  );
}
