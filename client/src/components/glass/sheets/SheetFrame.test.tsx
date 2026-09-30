import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SheetFrame } from './SheetFrame';

/**
 * The sheet frame: a modal page that covers the conversation pane. Geometry is
 * CSS (checked against the running app in e2e/glass-sheets.spec.ts); this holds
 * what a sheet must do for a keyboard and a screen reader.
 */

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../../../hooks/useMobile', () => ({ useMobile: () => mobile.value }));

beforeEach(() => {
  mobile.value = false;
  document.body.innerHTML = '';
});

function Host({ initiallyOpen = true, onBack }: { initiallyOpen?: boolean; onBack?: () => void }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open the sheet
      </button>
      <SheetFrame
        open={open}
        onClose={() => setOpen(false)}
        kind="test"
        label="A sheet"
        title="A sheet"
        subtitle="Under the title"
        closeLabel="Close the sheet"
        onBack={onBack}
        backLabel="Back to the list"
      >
        <button type="button">First control</button>
        <input aria-label="A field" data-sheet-autofocus="" />
        <button type="button">Last control</button>
      </SheetFrame>
    </>
  );
}

describe('SheetFrame', () => {
  it('is a modal dialog with a name, a title and a line under it', () => {
    render(<Host />);
    const dialog = screen.getByRole('dialog', { name: 'A sheet' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('data-sheet', 'test');
    expect(screen.getByRole('heading', { name: 'A sheet' })).toBeInTheDocument();
    expect(screen.getByText('Under the title')).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    render(<Host initiallyOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('covers the conversation pane when there is one, and the window when there is not', () => {
    const pane = document.createElement('main');
    pane.id = 'main-content';
    document.body.appendChild(pane);
    const { unmount } = render(<Host />);
    expect(pane).toContainElement(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-host', 'pane');
    unmount();
    pane.remove();

    render(<Host />);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-host', 'window');
  });

  it('is the whole screen on a phone, even with a pane on the page', () => {
    mobile.value = true;
    const pane = document.createElement('main');
    pane.id = 'main-content';
    document.body.appendChild(pane);
    render(<Host />);
    expect(pane).not.toContainElement(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-host', 'window');
  });

  it('puts focus on the field it names, not on the first control', () => {
    render(<Host />);
    expect(screen.getByRole('textbox', { name: 'A field' })).toHaveFocus();
  });

  it('closes on Escape and gives focus back to what opened it', async () => {
    const user = userEvent.setup();
    render(<Host initiallyOpen={false} />);
    const opener = screen.getByRole('button', { name: 'Open the sheet' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
    // The leave plays for a beat, then the sheet is gone.
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps Tab inside the sheet, both ways round', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('closes from its close button', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Close the sheet' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows a back button only for a page pushed over another', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Host />);
    expect(screen.queryByRole('button', { name: 'Back to the list' })).not.toBeInTheDocument();
    const onBack = vi.fn();
    rerender(<Host onBack={onBack} />);
    await user.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
