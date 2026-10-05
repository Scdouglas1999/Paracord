import { act, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHROME_FADE_MS, CHROME_IDLE_MS, useIdleChrome } from './useIdleChrome';

/**
 * The chrome over a stream that fills the window (docs/index-spec.md §7.7):
 * there on a pointer move, gone after two still seconds (faded, then not
 * painted), kept while the pointer or a menu is on it, and nothing left
 * running once it is gone.
 */

function Surface({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  useIdleChrome(ref, enabled);
  return (
    <section ref={ref} data-testid="surface">
      <header className="ix-call-head">
        <button type="button" aria-expanded="false">
          More
        </button>
      </header>
      <div className="ix-call__main" data-testid="stream" />
    </section>
  );
}

const chrome = (el: HTMLElement) => el.dataset.chrome;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useIdleChrome', () => {
  it('shows on entering, goes after two still seconds (hidden, then gone), and comes back on a move', () => {
    const { getByTestId } = render(<Surface enabled />);
    const surface = getByTestId('surface');
    expect(chrome(surface)).toBe('shown');
    act(() => vi.advanceTimersByTime(CHROME_IDLE_MS - 10));
    expect(chrome(surface)).toBe('shown');
    act(() => vi.advanceTimersByTime(10));
    expect(chrome(surface)).toBe('hidden');
    act(() => vi.advanceTimersByTime(CHROME_FADE_MS));
    expect(chrome(surface)).toBe('gone');
    // At rest nothing is left to run.
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.pointerMove(getByTestId('stream'), { clientX: 10, clientY: 10 });
    expect(chrome(surface)).toBe('shown');
    // A move without movement (some systems repeat one) wakes nothing.
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.pointerMove(getByTestId('stream'), { clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    expect(chrome(surface)).toBe('hidden');
  });

  it('every move restarts the two seconds', () => {
    const { getByTestId } = render(<Surface enabled />);
    const surface = getByTestId('surface');
    for (let i = 0; i < 5; i += 1) {
      act(() => vi.advanceTimersByTime(1000));
      fireEvent.pointerMove(getByTestId('stream'), { clientX: i, clientY: 0 });
    }
    expect(chrome(surface)).toBe('shown');
    act(() => vi.advanceTimersByTime(CHROME_IDLE_MS));
    expect(chrome(surface)).toBe('hidden');
  });

  it('stays while the pointer is on the chrome', () => {
    const { getByTestId, getByRole } = render(<Surface enabled />);
    const surface = getByTestId('surface');
    // jsdom lays nothing out: the hit test says what is under the pointer.
    document.elementFromPoint = (x: number) => (x < 10 ? getByRole('button', { name: 'More' }) : getByTestId('stream'));
    fireEvent.pointerMove(getByRole('button', { name: 'More' }), { clientX: 5, clientY: 5 });
    act(() => vi.advanceTimersByTime(CHROME_IDLE_MS * 3));
    expect(chrome(surface)).toBe('shown');
    fireEvent.pointerMove(getByTestId('stream'), { clientX: 50, clientY: 50 });
    act(() => vi.advanceTimersByTime(CHROME_IDLE_MS));
    expect(chrome(surface)).toBe('hidden');
    delete (document as Partial<Document>).elementFromPoint;
  });

  it('stays while a menu it opened is up', () => {
    const { getByTestId, getByRole } = render(<Surface enabled />);
    const surface = getByTestId('surface');
    getByRole('button', { name: 'More' }).setAttribute('aria-expanded', 'true');
    act(() => vi.advanceTimersByTime(CHROME_IDLE_MS * 3));
    expect(chrome(surface)).toBe('shown');
    getByRole('button', { name: 'More' }).setAttribute('aria-expanded', 'false');
    act(() => vi.advanceTimersByTime(CHROME_IDLE_MS));
    expect(chrome(surface)).toBe('hidden');
  });

  it('off, it leaves no attribute and no timer', () => {
    const { getByTestId, rerender } = render(<Surface enabled />);
    rerender(<Surface enabled={false} />);
    expect(getByTestId('surface')).not.toHaveAttribute('data-chrome');
    expect(vi.getTimerCount()).toBe(0);
  });
});
