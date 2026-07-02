import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useFocusTrap } from './useFocusTrap';

function FocusTrapHarness({
  active = true,
  onClose = vi.fn(),
}: {
  active?: boolean;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active, onClose);

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Focus trap test dialog" tabIndex={-1}>
      <button type="button">First</button>
      <button type="button">Second</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable element when activated', () => {
    render(<FocusTrapHarness />);

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('wraps Tab focus inside the active container', () => {
    render(<FocusTrapHarness />);

    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });

    second.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(second).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<FocusTrapHarness onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores the previously focused element when unmounted', () => {
    render(<button type="button">Before dialog</button>);
    const previous = screen.getByRole('button', { name: 'Before dialog' });
    previous.focus();

    const { unmount } = render(<FocusTrapHarness />);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();

    unmount();

    expect(previous).toHaveFocus();
  });
});
