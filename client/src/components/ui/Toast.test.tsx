import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../stores/toastStore';
import { ToastContainer } from './Toast';

/**
 * Toasts (docs/index-spec.md §5.18, §6.8): a near-solid capsule at the top
 * center of main under the toolbar; an error carries its glyph and the danger
 * ink on the words, never a red fill; they arrive from 8px above, leave after
 * a beat, and the store removes one after four seconds by default.
 */

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  document.querySelectorAll('.ix-main').forEach((node) => node.remove());
  vi.useRealTimers();
  useToastStore.setState({ toasts: [] });
});

describe('ToastContainer', () => {
  it('draws a status capsule with the message and a dismiss control', () => {
    render(<ToastContainer />);
    act(() => useToastStore.getState().addToast('info', 'Link copied'));
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Link copied');
    expect(toast.className).toContain('rounded-full');
    expect(toast.className).toContain('text-[13.5px]');
    expect(toast.className).toContain('font-semibold');
    expect(toast.className).toContain('bg-[var(--ix-capsule)]');
    expect(toast).toHaveClass('pc-toast-in');
    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toBeInTheDocument();
  });

  it('an error is an alert with its glyph and the danger ink on the words, never a red fill', () => {
    render(<ToastContainer />);
    act(() => useToastStore.getState().addToast('error', 'Could not send that message'));
    const toast = screen.getByRole('alert');
    expect(toast.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Could not send that message')).toHaveClass('text-[var(--ix-danger-ink)]');
    expect(toast.className).not.toMatch(/danger-fill|bg-red|bg-\[var\(--ix-danger/);
  });

  it('a success or info toast has no glyph and no color: ink on the capsule', () => {
    render(<ToastContainer />);
    act(() => useToastStore.getState().addToast('success', 'Saved'));
    // The only glyph is the dismiss control's.
    const glyphs = screen.getByRole('status').querySelectorAll('svg');
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].closest('button')).toHaveAccessibleName('Dismiss notification');
  });

  it('one text action: pressing it runs it and removes the toast', async () => {
    const onClick = vi.fn();
    render(<ToastContainer />);
    act(() => useToastStore.getState().addToast('success', 'Saved the clip', 4000, { label: 'Post to General', onClick }));
    await userEvent.click(screen.getByRole('button', { name: 'Post to General' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('sits at the top center of main under the toolbar', () => {
    const main = document.createElement('main');
    main.className = 'ix-main';
    main.getBoundingClientRect = () => rect(316, 0, 964, 800);
    document.body.appendChild(main);
    const { baseElement } = render(<ToastContainer />);
    act(() => useToastStore.getState().addToast('info', 'Link copied'));
    const stack = baseElement.querySelector('[aria-live="polite"][aria-atomic="false"]') as HTMLElement;
    expect(stack.style.top).toBe(`${58 + 8}px`);
    expect(stack.style.left).toBe('316px');
    expect(stack.style.width).toBe('964px');
    expect(stack.className).toContain('items-center');
  });

  it('falls back to the top center of the window when there is no main', () => {
    const { baseElement } = render(<ToastContainer />);
    act(() => useToastStore.getState().addToast('info', 'Link copied'));
    const stack = baseElement.querySelector('[aria-live="polite"][aria-atomic="false"]') as HTMLElement;
    expect(stack.style.left).toBe('0px');
    expect(stack.style.right).toBe('0px');
  });

  it('the store drops a toast after four seconds by default; the leave is held for a beat, then it is gone', () => {
    vi.useFakeTimers();
    render(<ToastContainer />);
    act(() => useToastStore.getState().addToast('info', 'Link copied'));
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
    // Still on screen for its leave (200ms), out of the accessibility tree.
    const leaving = screen.getByText('Link copied').closest('[data-toast-type]') as HTMLElement;
    expect(leaving).toHaveClass('pc-toast-out');
    expect(leaving).toHaveAttribute('aria-hidden', 'true');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Link copied')).toBeNull();
  });
});
