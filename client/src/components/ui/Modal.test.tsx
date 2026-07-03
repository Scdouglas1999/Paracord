import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, ModalTitle } from './Modal';

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  return (
    <Modal open onClose={onClose} labelledBy="t" showCloseButton>
      <ModalTitle id="t">Test dialog</ModalTitle>
      <button type="button">first</button>
      <button type="button">second</button>
    </Modal>
  );
}

describe('Modal', () => {
  it('renders a labelled modal dialog into a portal', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Test dialog' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('tabindex', '-1');
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
  });
});
