import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useToolbarStore } from '../shell/toolbarStore';
import { LargeTitlePage, foldProgress } from '.';
import { MISSING_TITLE_MS, useTitleFold } from './useTitleFold';

let frames: Array<() => void> = [];

beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(() => callback(performance.now()));
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  useToolbarStore.setState({ page: null, owner: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Scroll the page's scroller and run the one frame the fold waits for. */
function scrollTo(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
  act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((frame) => frame());
  });
}

describe('the title fold (§5.14)', () => {
  it('is t = min(1, scrollTop / 60)', () => {
    expect(foldProgress(0)).toBe(0);
    expect(foldProgress(30)).toBe(0.5);
    expect(foldProgress(60)).toBe(1);
    expect(foldProgress(400)).toBe(1);
    expect(foldProgress(-5)).toBe(0);
  });

  it('scales and fades the large title with the scroll, and folds the toolbar past 40px', () => {
    render(
      <LargeTitlePage title="Overview" subtitle="Fuel's home" data-testid="page">
        <p>body</p>
      </LargeTitlePage>,
    );
    const scroller = screen.getByTestId('page');
    const title = screen.getByTestId('ix-title');
    const block = title.closest('.ix-large-title') as HTMLElement;
    expect(title).toHaveTextContent('Overview');
    expect(screen.getByText("Fuel's home")).toHaveClass('ix-large-title__sub');
    expect(useToolbarStore.getState().page).toMatchObject({ title: 'Overview', folded: false });

    scrollTo(scroller, 30);
    expect(block.style.transform).toBe('scale(0.9500)');
    expect(Number(block.style.opacity)).toBeCloseTo(0.55);
    expect(useToolbarStore.getState().page?.folded).toBe(false);

    scrollTo(scroller, 41);
    expect(useToolbarStore.getState().page?.folded).toBe(true);

    scrollTo(scroller, 300);
    expect(block.style.transform).toBe('scale(0.9000)');
    expect(Number(block.style.opacity)).toBeCloseTo(0.1);

    scrollTo(scroller, 0);
    expect(block.style.transform).toBe('');
    expect(block.style.opacity).toBe('');
    expect(useToolbarStore.getState().page?.folded).toBe(false);
  });

  it('coalesces scroll events into one update per frame', () => {
    render(<LargeTitlePage title="Events" data-testid="page" />);
    const scroller = screen.getByTestId('page');
    scroller.scrollTop = 10;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 20;
    fireEvent.scroll(scroller);
    fireEvent.scroll(scroller);
    expect(frames).toHaveLength(1);
  });

  it('hands the toolbar the title action, the back chevron and the call button', () => {
    const onTitleClick = vi.fn();
    const onBack = vi.fn();
    render(
      <LargeTitlePage
        title="Thread"
        onTitleClick={onTitleClick}
        titleHasPopup="menu"
        onBack={onBack}
        backLabel="Back to general"
        search={false}
      />,
    );
    const page = useToolbarStore.getState().page;
    expect(page).toMatchObject({ title: 'Thread', titleHasPopup: 'menu', backLabel: 'Back to general', search: false });
    expect(page?.onBack).toBe(onBack);
    // The large title is the same button.
    act(() => screen.getByRole('button', { name: 'Thread' }).click());
    expect(onTitleClick).toHaveBeenCalled();
  });
});

describe('a title that is not mounted (IX-18)', () => {
  const scroller = (overflows: boolean) => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: overflows ? 2000 : 400 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 600 });
    return element;
  };

  it('folds only after it has stayed away a moment, and only with something to have scrolled past', () => {
    vi.useFakeTimers();
    try {
      const long = renderHook(() => useTitleFold(scroller(true)));
      expect(long.result.current.folded).toBe(false);
      act(() => {
        vi.advanceTimersByTime(MISSING_TITLE_MS);
      });
      expect(long.result.current.folded).toBe(true);
      // A short list between two commits of a switch: never folded (no fill flash).
      const short = renderHook(() => useTitleFold(scroller(false)));
      act(() => {
        vi.advanceTimersByTime(MISSING_TITLE_MS * 2);
      });
      expect(short.result.current.folded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
