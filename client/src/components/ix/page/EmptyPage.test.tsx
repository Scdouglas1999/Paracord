import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CreamButton } from '../primitives';
import { EmptyPage } from '.';

describe('EmptyPage (docs/index-spec.md §6.8)', () => {
  it('is a mark, a title, a line and one action', () => {
    render(
      <EmptyPage
        glyph="hello"
        title="This channel is gone"
        line="It may have been deleted."
        action={<CreamButton>Go to general</CreamButton>}
      />,
    );
    const page = screen.getByTestId('ix-empty');
    expect(screen.getByRole('heading', { level: 1, name: 'This channel is gone' })).toHaveClass('ix-empty__title');
    expect(page).toHaveTextContent('It may have been deleted.');
    expect(page.querySelector('.ix-empty__tile.ix-hue-tile svg')).not.toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    // The tile is decoration: the title says it.
    expect(page.querySelector('.ix-empty__tile')).toHaveAttribute('aria-hidden', 'true');
  });

  it('leaves the tile, the line and the action out when it has none', () => {
    const { container } = render(<EmptyPage title="Nothing here" />);
    expect(container.querySelector('.ix-empty__tile')).toBeNull();
    expect(container.querySelector('.ix-empty__line')).toBeNull();
    expect(container.querySelector('.ix-empty__action')).toBeNull();
  });

  it('takes the place’s hue for its tile, and is a labeled region when it is given a name', () => {
    render(<EmptyPage glyph="lock" hue={195} aria-label="Server not found" title="Not yours" />);
    const page = screen.getByRole('region', { name: 'Server not found' });
    expect(page.style.getPropertyValue('--ix-hue')).toBe('195');
  });

  it('announces a failure when it is one', () => {
    render(<EmptyPage role="alert" title="Couldn’t load channels" line="Offline." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Offline.');
  });

  it('is a block inside a page when inline (the Events page with no events), not main’s whole height', () => {
    render(<EmptyPage inline title="No events" />);
    expect(screen.getByTestId('ix-empty')).toHaveAttribute('data-inline', 'true');
  });
});
