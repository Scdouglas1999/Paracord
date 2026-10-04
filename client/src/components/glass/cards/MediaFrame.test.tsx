import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GlassFile, GlassMedia, fitMedia } from './MediaFrame';

/** Media and file bubbles in the timeline (docs/index-spec.md §4.11). */

describe('a media bubble', () => {
  it('fits a picture inside 360×360, never enlarging it', () => {
    expect(fitMedia(480, 270)).toEqual({ width: 360, height: 203 });
    expect(fitMedia(300, 900)).toEqual({ width: 120, height: 360 });
    expect(fitMedia(200, 100)).toEqual({ width: 200, height: 100 });
    expect(fitMedia(undefined, 100)).toBeNull();
    expect(fitMedia(0, 0)).toBeNull();
  });

  it('carries its joined corners and keeps the reactions outside the frame that clips it', () => {
    const { container } = render(
      <GlassMedia joinTop joinBottom width={480} height={270} bite={<span data-testid="bite" />}>
        <img alt="" />
      </GlassMedia>,
    );
    const media = container.querySelector('.ix-media') as HTMLElement;
    expect(media).toHaveAttribute('data-join-top', 'true');
    expect(media).toHaveAttribute('data-join-bottom', 'true');
    expect(media.querySelector('.ix-media__frame')).toHaveStyle({ width: '360px' });
    expect(media.querySelector('.ix-media__frame')).not.toContainElement(screen.getByTestId('bite'));
  });
});

describe('a file card bubble', () => {
  it('names the file, its size and its note, with its actions as text', () => {
    render(<GlassFile name="notes.txt" size="2 KB" note="Preview off" actions={<button type="button">Download</button>} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
    expect(screen.getByText('2 KB · Preview off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' }).closest('.ix-file__actions')).not.toBeNull();
  });
});
