import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SplitPaneSourcePicker } from './SplitPaneSourcePicker';

describe('SplitPaneSourcePicker', () => {
  const participantNames = new Map([['u2', 'Alice']]);

  it('portals the source menu to document.body and closes on Escape', () => {
    render(
      <div data-testid="mount">
        <SplitPaneSourcePicker
          source={{ type: 'none' }}
          onSourceChange={vi.fn()}
          activeStreamers={['u2']}
          webcamTiles={[]}
          participantNames={participantNames}
          otherPaneSource={{ type: 'none' }}
          currentUserId="me"
        />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const portal = document.querySelector('[data-stream-overlay-portal]');
    expect(portal).not.toBeNull();
    expect(portal?.parentElement).toBe(document.body);
    expect(screen.getByTestId('mount').contains(portal)).toBe(false);
    expect(screen.getByText('Alice')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-stream-overlay-portal]')).toBeNull();
  });

  it('selects a stream source and closes the menu', () => {
    const onSourceChange = vi.fn();
    render(
      <SplitPaneSourcePicker
        source={{ type: 'none' }}
        onSourceChange={onSourceChange}
        activeStreamers={['u2']}
        webcamTiles={[]}
        participantNames={participantNames}
        otherPaneSource={{ type: 'none' }}
        currentUserId="me"
      />,
    );

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByText('Alice'));
    expect(onSourceChange).toHaveBeenCalledWith({ type: 'stream', userId: 'u2' });
    expect(document.querySelector('[data-stream-overlay-portal]')).toBeNull();
  });
});
