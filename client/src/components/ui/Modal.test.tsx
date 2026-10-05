import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from './Modal';

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  return (
    <Modal open onClose={onClose} labeledBy="t" showCloseButton>
      <ModalTitle id="t">Test dialog</ModalTitle>
      <button type="button">first</button>
      <button type="button">second</button>
    </Modal>
  );
}

describe('Modal', () => {
  it('renders a labeled modal dialog into a portal', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Test dialog' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(dialog).toHaveClass(
      'max-h-[calc(100dvh-2rem)]',
      'max-w-[calc(100vw-2rem)]',
    );
    // Portalled to body, not inside the React root container.
    expect(dialog.closest('#root')).toBeNull();
  });

  it('traps Tab focus within the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const close = screen.getByRole('button', { name: 'Close' });
    const first = screen.getByRole('button', { name: 'first' });
    const second = screen.getByRole('button', { name: 'second' });

    // Focus starts inside (first focusable).
    await waitFor(() => expect(document.activeElement).toBe(close));

    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab();
    expect(document.activeElement).toBe(second);
    // Wraps back to the first focusable instead of escaping the dialog.
    await user.tab();
    expect(document.activeElement).toBe(close);
  });

  it('closes on Escape and on backdrop click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Backdrop is the fixed inset container wrapping the dialog panel.
    const dialog = screen.getByRole('dialog', { name: 'Test dialog' });
    const backdrop = dialog.parentElement;
    expect(backdrop).toBeTruthy();
    await user.pointer({ keys: '[MouseLeft>]', target: backdrop! });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('Modal look (docs/index-spec.md §6.12)', () => {
  it('is the card at radius 20 over a scrim, and enters on the dialog recipe (not the page one)', () => {
    render(
      <Modal open onClose={() => {}} labeledBy="t" size="sm">
        <ModalTitle id="t">Leave Fuel?</ModalTitle>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Leave Fuel?' });
    expect(dialog).toHaveClass('pc-dialog', 'pc-dialog-enter', 'max-w-[440px]');
    expect(dialog).not.toHaveClass('pc-enter');
    const backdrop = dialog.parentElement!;
    expect(backdrop).toHaveClass('modal-backdrop', 'pc-scrim-in');
    expect(backdrop.className).toContain('bg-[var(--ix-scrim)]');
  });

  it('title 17/700, body 14 ink-2, actions right-aligned', () => {
    render(
      <Modal open onClose={() => {}} labeledBy="t">
        <ModalHeader>
          <ModalTitle id="t">Delete plans?</ModalTitle>
          <ModalDescription>It cannot be undone.</ModalDescription>
        </ModalHeader>
        <ModalFooter>
          <button type="button">Cancel</button>
        </ModalFooter>
      </Modal>,
    );
    expect(screen.getByText('Delete plans?').className).toContain('text-[17px]');
    expect(screen.getByText('Delete plans?').className).toContain('font-bold');
    expect(screen.getByText('It cannot be undone.').className).toContain('text-[14px]');
    expect(screen.getByText('It cannot be undone.').className).toContain('text-[var(--ix-ink-2)]');
    expect(screen.getByRole('button', { name: 'Cancel' }).parentElement).toHaveClass('justify-end');
  });
});
