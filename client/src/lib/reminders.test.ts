import { describe, expect, it } from 'vitest';
import { reminderChoices, reminderConfirmCopy, reminderWhen } from './reminders';

describe('reminder times', () => {
  it('puts next Monday a week out when today is Monday', () => {
    const monday = new Date(2026, 8, 21, 15, 0, 0);
    expect(monday.getDay()).toBe(1);
    const next = reminderChoices(monday).find((choice) => choice.label.startsWith('Next week'));
    expect(next?.at.getDay()).toBe(1);
    expect(next?.at.getDate()).toBe(28);
    expect(next?.at.getHours()).toBe(9);
  });

  it('confirms tomorrow at the wall clock', () => {
    const now = new Date(2026, 8, 22, 14, 0, 0);
    const at = new Date(2026, 8, 23, 9, 0, 0);
    expect(reminderConfirmCopy(at, now)).toMatch(/^I'll remind you tomorrow at 9:00/);
  });

  it('names the weekday within a week and the date beyond it', () => {
    const now = new Date(2026, 8, 22, 14, 0, 0);
    expect(reminderWhen(new Date(2026, 8, 22, 16, 30, 0), now)).toMatch(/^today at /);
    expect(reminderWhen(new Date(2026, 8, 25, 9, 0, 0), now)).toMatch(/^Friday at /);
    expect(reminderWhen(new Date(2026, 9, 5, 9, 0, 0), now)).not.toMatch(/^(today|tomorrow)/);
  });
});
