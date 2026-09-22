import { wallClock } from './formatters';

export interface ReminderChoice {
  label: string;
  at: Date;
}

/** The fixed choices on Remind me. "Pick a date and time…" is separate. */
export function reminderChoices(now = new Date()): ReminderChoice[] {
  const shifted = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
  const monday = new Date(now);
  monday.setDate(monday.getDate() + daysUntilMonday);
  monday.setHours(9, 0, 0, 0);
  return [
    { label: 'In 20 minutes', at: shifted(20) },
    { label: 'In 1 hour', at: shifted(60) },
    { label: 'In 3 hours', at: shifted(180) },
    { label: 'Tomorrow (9:00)', at: tomorrow },
    { label: 'Next week (Monday 9:00)', at: monday },
  ];
}

/** Whole days from `now`'s date to `at`'s date, in local time. */
function dayOffset(at: Date, now: Date): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return Math.round((day.getTime() - start.getTime()) / 86_400_000);
}

/**
 * When a reminder is set for, in words: "today at 3:20 pm", "tomorrow at
 * 9:00", "Monday at 9:00", or a date further out. Same clock as the timeline.
 */
export function reminderWhen(at: Date, now = new Date()): string {
  const clock = wallClock(at);
  const diff = dayOffset(at, now);
  if (diff === 0) return `today at ${clock}`;
  if (diff === 1) return `tomorrow at ${clock}`;
  if (diff > 1 && diff < 7) return `${at.toLocaleDateString(undefined, { weekday: 'long' })} at ${clock}`;
  return `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at ${clock}`;
}

/** Toast copy after a reminder is saved: "I'll remind you tomorrow at 9:00". */
export function reminderConfirmCopy(at: Date, now = new Date()): string {
  return `I'll remind you ${reminderWhen(at, now)}`;
}

export function snoozeAt(now = new Date()): Date {
  return new Date(now.getTime() + 60 * 60_000);
}
