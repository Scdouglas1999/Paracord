import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Segmented, segmentedIds } from './Segmented';

const ITEMS = [
  { value: 'online', label: 'Online', count: 3 },
  { value: 'all', label: 'All', count: 0 },
  { value: 'requests', label: 'Requests', count: 120 },
] as const;

function Harness({ idBase }: { idBase?: string }) {
  const [value, setValue] = useState<(typeof ITEMS)[number]['value']>('online');
  return (
    <>
      <Segmented label="Show" items={ITEMS} value={value} onChange={setValue} idBase={idBase} />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe('Segmented', () => {
  it('is a tablist with the chosen segment selected and the only Tab stop', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Show' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Online/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^Online/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('tabindex', '-1');
  });

  it('draws a count after the label, none for zero, and caps a long one', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Online 3' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Requests 99+' })).toBeInTheDocument();
  });

  it('a click chooses', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByTestId('value')).toHaveTextContent('all');
  });

  it('the arrow keys, Home and End move AND choose, wrapping at both ends', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: /^Online/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('value')).toHaveTextContent('all');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByTestId('value')).toHaveTextContent('requests');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('value')).toHaveTextContent('online');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('value')).toHaveTextContent('requests');
    await user.keyboard('{Home}');
    expect(screen.getByTestId('value')).toHaveTextContent('online');
  });

  it('names its panel and tabs from one id base, so the page can label its panel after the tab', () => {
    render(<Harness idBase="ix-friends" />);
    const ids = segmentedIds('ix-friends', 'online');
    expect(screen.getByRole('tab', { name: /^Online/ })).toHaveAttribute('id', ids.tab);
    expect(screen.getByRole('tab', { name: /^Online/ })).toHaveAttribute('aria-controls', ids.panel);
  });
});
