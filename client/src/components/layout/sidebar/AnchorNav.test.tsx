import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AnchorNav } from './AnchorNav';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderNav(props: Partial<Parameters<typeof AnchorNav>[0]> = {}, path = '/app') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AnchorNav friendRequestCount={0} navIndexStart={0} {...props} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('AnchorNav', () => {
  it('renders the three fixed anchors as roving rows from navIndexStart', () => {
    renderNav({ navIndexStart: 5 });
    expect(screen.getByRole('option', { name: /^Home$/ })).toHaveAttribute('data-nav-index', '5');
    expect(screen.getByRole('option', { name: /^Friends$/ })).toHaveAttribute('data-nav-index', '6');
    expect(screen.getByRole('option', { name: /^Messages$/ })).toHaveAttribute('data-nav-index', '7');
  });

  it('marks Home active on the app index and nothing else', () => {
    renderNav({}, '/app');
    expect(screen.getByRole('option', { name: /^Home$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /^Friends$/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('marks Messages active on any DM route', () => {
    renderNav({}, '/app/dms/123');
    expect(screen.getByRole('option', { name: /^Messages$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /^Home$/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('shows an emerald request badge on Friends only when there are incoming requests', () => {
    const { rerender } = renderNav({ friendRequestCount: 0 });
    expect(screen.queryByTestId('anchor-badge-friends')).not.toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={['/app']}>
        <AnchorNav friendRequestCount={4} navIndexStart={0} />
      </MemoryRouter>,
    );
    const badge = screen.getByTestId('anchor-badge-friends');
    expect(badge).toHaveTextContent('4');
    expect(badge.className).toContain('bg-accent-primary');
    expect(badge.className).toContain('text-text-on-accent');
  });

  it('caps the request badge at 99+', () => {
    renderNav({ friendRequestCount: 250 });
    expect(screen.getByTestId('anchor-badge-friends')).toHaveTextContent('99+');
  });

  it('navigates to the anchor route on click', () => {
    renderNav({}, '/app');
    fireEvent.click(screen.getByRole('option', { name: /^Friends$/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/friends');
  });

  it('single-tab-stop: exactly the activeNavIndex row is tabbable', () => {
    renderNav({ navIndexStart: 0, activeNavIndex: 1 });
    expect(screen.getByRole('option', { name: /^Home$/ })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('option', { name: /^Friends$/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('option', { name: /^Messages$/ })).toHaveAttribute('tabindex', '-1');
  });
});
