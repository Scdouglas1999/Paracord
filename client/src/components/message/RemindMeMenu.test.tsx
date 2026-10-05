import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useReminderStore } from '../../stores/reminderStore';
import { RemindMeMenu } from './RemindMeMenu';

/**
 * Remind me (docs/index-spec.md §6.11, §8.4): a menu in the Index look (rows 36,
 * 14/500, the shared popover), a few fixed times with their clock time at the
 * right in capitals, and a date and time with one cream button.
 */

function renderMenu(onClose = vi.fn()) {
  const anchor = createRef<HTMLButtonElement>();
  render(
    <>
      <button ref={anchor} type="button">
        anchor
      </button>
      <RemindMeMenu anchor={anchor} open onClose={onClose} channelId="c1" messageId="m1" />
    </>,
  );
  return { onClose };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useReminderStore.setState({ items: [] } as never);
});

describe('RemindMeMenu', () => {
  it('is a named menu on the floating surface with the fixed times as rows', () => {
    renderMenu();
    const menu = screen.getByRole('menu', { name: 'Remind me' });
    expect(menu).toHaveClass('pc-floating');
    const rows = within(menu).getAllByRole('menuitem');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.at(-1)).toHaveTextContent('Pick a date and time');
    for (const row of rows) {
      expect(row).toHaveClass('h-9', 'text-[14px]', 'font-medium');
    }
  });

  it('shows the clock time of an "In ..." row in capitals, tabular, at the right', () => {
    renderMenu();
    const row = within(screen.getByRole('menu')).getAllByRole('menuitem').find((item) => item.textContent?.startsWith('In '))!;
    const time = row.lastElementChild as HTMLElement;
    expect(time).toHaveClass('tabular-nums');
    expect(time.textContent).toBe(time.textContent?.toUpperCase());
  });

  it('opens the date and time field with one cream button, and says why a time in the past is refused', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('menuitem', { name: /Pick a date and time/ }));
    const field = screen.getByLabelText('Date and time');
    const submit = screen.getByRole('button', { name: 'Set reminder' });
    expect(submit.className).toContain('bg-accent-primary');
    fireEvent.change(field, { target: { value: '2001-01-01T10:00' } });
    // The field's own `min` would stop a real submit before the words appear: submit the form itself.
    fireEvent.submit(submit.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a time in the future.');
  });

  it('saves a fixed time and closes', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    useReminderStore.setState({ save } as never);
    const user = userEvent.setup();
    const { onClose } = renderMenu();
    await user.click(within(screen.getByRole('menu')).getAllByRole('menuitem')[0]);
    await waitFor(() => expect(save).toHaveBeenCalledWith('c1', 'm1', expect.any(String)));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
