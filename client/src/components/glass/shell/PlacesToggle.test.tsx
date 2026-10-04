import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMobile } from '../../../hooks/useMobile';
import { useGlassStore } from '../../../stores/glassStore';
import { PlacesToggle } from './PlacesToggle';
import { usePhoneNavStore } from './phoneNav';

vi.mock('../../../hooks/useMobile', () => ({
  useMobile: vi.fn(() => false),
  DEFAULT_MOBILE_MAX_WIDTH: 768,
}));

const mockedUseMobile = vi.mocked(useMobile);

beforeEach(() => {
  mockedUseMobile.mockReset();
  mockedUseMobile.mockReturnValue(false);
  useGlassStore.getState().reset();
  usePhoneNavStore.getState().setScreen('conversation');
});

describe('PlacesToggle', () => {
  it('is nothing on the wide frame: places is a pane there', () => {
    const { container } = render(<PlacesToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is nothing on the old compact width either: the Index frame has no places overlay', () => {
    mockedUseMobile.mockImplementation((maxWidth?: number) => maxWidth === 860);
    const { container } = render(<PlacesToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is the back button to the places screen on a phone', () => {
    mockedUseMobile.mockReturnValue(true);
    render(<PlacesToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to places' }));
    expect(usePhoneNavStore.getState().screen).toBe('places');
    // It is the phone's screen, not the compact frame's overlay.
    expect(useGlassStore.getState().placesOverlayOpen).toBe(false);
  });

  it('does not open a dialog on a phone: it has nothing to expand', () => {
    mockedUseMobile.mockReturnValue(true);
    render(<PlacesToggle />);
    const button = screen.getByRole('button', { name: 'Back to places' });
    expect(button).not.toHaveAttribute('aria-haspopup');
    expect(button).not.toHaveAttribute('aria-expanded');
  });
});
