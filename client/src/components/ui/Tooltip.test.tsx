// A tooltip has to let go of the control when you press it.
//
// The pointer never leaves a button that opens a dialog — the dialog appears
// underneath it — so no mouseleave fires, and the label stayed pinned at
// z-9999 on top of the panel it had just opened: "Open user settings" over the
// settings panel, "Building settings" over the building panel, on every screen
// where a tooltipped control opens something.

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Tooltip } from './Tooltip';

function renderTooltip() {
  render(
    <Tooltip content="Open user settings">
      <button type="button">gear</button>
    </Tooltip>,
  );
  return screen.getByText('gear').parentElement as HTMLElement;
}

describe('Tooltip', () => {
  it('shows the label on hover', async () => {
    const trigger = renderTooltip();
    fireEvent.mouseEnter(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Open user settings');
  });

  it('lets go when the control it labels is pressed', async () => {
    const trigger = renderTooltip();
    fireEvent.mouseEnter(trigger);
    await screen.findByRole('tooltip');

    fireEvent.pointerDown(trigger);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});
