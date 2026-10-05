import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerComposerFiles } from '../../message/composerFiles';
import { toast } from '../../../stores/toastStore';
import { DropTarget, dragHasFiles } from './DropTarget';
import { useRef } from 'react';

/**
 * The full-main drop target (docs/index-spec.md §4.12): files dragged over main show
 * "Drop to share in general" and a drop hands them to the message box; a drop ON
 * the box is the box's own.
 */
function Main({ readOnly = false }: { readOnly?: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  return (
    <main className="ix-main" data-testid="main">
      <div ref={root}>
        <div data-testid="feed" />
        <div data-testid="ix-composer" data-read-only={readOnly ? '' : undefined}>
          {!readOnly && <textarea data-composer-input="" />}
        </div>
        <DropTarget root={root} channelId="c1" name="general" />
      </div>
    </main>
  );
}

const files = [new File(['x'], 'a.png', { type: 'image/png' })];
const transfer = (types: string[] = ['Files'], withFiles: File[] = files) => ({ types, files: withFiles, dropEffect: 'none' });

let unregister: () => void;
const staged = vi.fn();

beforeEach(() => {
  staged.mockReset();
  unregister = registerComposerFiles('c1', staged);
  vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
});
afterEach(() => {
  unregister();
  cleanup();
  vi.restoreAllMocks();
});

describe('DropTarget', () => {
  it('knows files from text dragged around the page', () => {
    expect(dragHasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
    expect(dragHasFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });

  it('shows the target while files are dragged over main, and says where they would go', () => {
    render(<Main />);
    expect(screen.queryByTestId('ix-drop-target')).not.toBeInTheDocument();
    act(() => void fireEvent.dragEnter(screen.getByTestId('feed'), { dataTransfer: transfer() }));
    expect(screen.getByTestId('ix-drop-target')).toHaveTextContent('Drop to share in general');
    act(() => void fireEvent.dragLeave(screen.getByTestId('feed'), { dataTransfer: transfer() }));
    expect(screen.queryByTestId('ix-drop-target')).not.toBeInTheDocument();
  });

  it('ignores a drag that carries no files', () => {
    render(<Main />);
    act(() => void fireEvent.dragEnter(screen.getByTestId('feed'), { dataTransfer: transfer(['text/plain']) }));
    expect(screen.queryByTestId('ix-drop-target')).not.toBeInTheDocument();
  });

  it('a drop in main queues the files in the message box and clears the target', () => {
    render(<Main />);
    const feed = screen.getByTestId('feed');
    act(() => void fireEvent.dragEnter(feed, { dataTransfer: transfer() }));
    act(() => void fireEvent.dragOver(feed, { dataTransfer: transfer() }));
    act(() => void fireEvent.drop(feed, { dataTransfer: transfer() }));
    expect(staged).toHaveBeenCalledWith(files);
    expect(screen.queryByTestId('ix-drop-target')).not.toBeInTheDocument();
  });

  it('lets the drop through (it is a copy), so the page does not open the file', () => {
    render(<Main />);
    const feed = screen.getByTestId('feed');
    act(() => void fireEvent.dragEnter(feed, { dataTransfer: transfer() }));
    const dataTransfer = transfer();
    const proceed = fireEvent.dragOver(feed, { dataTransfer });
    expect(proceed).toBe(false); // preventDefault
    expect(dataTransfer.dropEffect).toBe('copy');
  });

  it('steps aside over the box, whose own drop it is, and never stages twice', () => {
    render(<Main />);
    const box = screen.getByTestId('ix-composer');
    act(() => void fireEvent.dragEnter(box, { dataTransfer: transfer() }));
    expect(screen.queryByTestId('ix-drop-target')).not.toBeInTheDocument();
    act(() => void fireEvent.drop(box, { dataTransfer: transfer() }));
    expect(staged).not.toHaveBeenCalled();
  });

  it('offers nothing where there is no box to take files', () => {
    render(<Main readOnly />);
    act(() => void fireEvent.dragEnter(screen.getByTestId('feed'), { dataTransfer: transfer() }));
    expect(screen.queryByTestId('ix-drop-target')).not.toBeInTheDocument();
  });

  it('says so when a drop finds no box open for the conversation', () => {
    unregister();
    render(<Main />);
    const feed = screen.getByTestId('feed');
    act(() => void fireEvent.dragEnter(feed, { dataTransfer: transfer() }));
    act(() => void fireEvent.drop(feed, { dataTransfer: transfer() }));
    expect(toast.error).toHaveBeenCalledWith('There is no message box open here to take these files.');
  });
});
