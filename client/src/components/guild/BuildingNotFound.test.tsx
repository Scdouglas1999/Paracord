import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BuildingNotFound } from './BuildingNotFound';

describe('a server you cannot open', () => {
  it('says so in the product’s own words, and gives a way back', async () => {
    const onGoHome = vi.fn();
    render(<BuildingNotFound onGoHome={onGoHome} />);

    expect(screen.getByRole('region', { name: 'Server not found' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /this server isn.t yours to open/i,
    );
    // Never the API's word for it.
    expect(document.body.textContent).not.toMatch(/forbidden|403|404/i);

    await userEvent.click(screen.getByRole('button', { name: 'Back to your servers' }));
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });
});
