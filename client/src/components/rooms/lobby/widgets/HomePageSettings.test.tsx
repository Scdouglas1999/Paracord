import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { HomePageSettings } from './HomePageSettings';
import { DEFAULT_HOME_WIDGETS } from './widgetConfig';

afterEach(cleanup);

describe('Home page settings', () => {
  it('switches a widget off', () => {
    const onChange = vi.fn();
    render(<HomePageSettings widgets={DEFAULT_HOME_WIDGETS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Media' }));
    expect(onChange).toHaveBeenCalledWith(
      DEFAULT_HOME_WIDGETS.map((widget) => (widget.id === 'media' ? { ...widget, enabled: false } : widget)),
    );
  });

  it('moves a widget with the arrow keys on its handle', () => {
    const onChange = vi.fn();
    render(<HomePageSettings widgets={DEFAULT_HOME_WIDGETS} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /^Move Pinned/ }), { key: 'ArrowUp' });
    expect(onChange.mock.calls[0][0].map((widget: { id: string }) => widget.id)).toEqual([
      'coming_up',
      'media',
      'most_active',
      'pinned',
      'game',
      'new_here',
    ]);
    expect(screen.getByText('Pinned moved to position 4 of 6.')).toBeInTheDocument();
  });

  it('previews only the widgets that are on, in order', () => {
    render(
      <HomePageSettings
        widgets={[
          { id: 'new_here', enabled: true },
          { id: 'coming_up', enabled: false },
          { id: 'media', enabled: true },
          { id: 'most_active', enabled: false },
          { id: 'game', enabled: false },
          { id: 'pinned', enabled: false },
        ]}
        onChange={() => {}}
      />,
    );
    const preview = screen.getByRole('figure', { name: 'Preview' });
    expect(within(preview).getAllByText(/^(New here|Media|Coming up)$/).map((node) => node.textContent)).toEqual([
      'New here',
      'Media',
    ]);
  });
});
