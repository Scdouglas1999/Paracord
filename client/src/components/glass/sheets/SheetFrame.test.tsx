import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IX_SHEET_HOST_ID } from '../../ix/shell/slots';
import { SheetFrame } from './SheetFrame';

/**
 * The sheet frame: a modal page that opens in the sheet host on main's right
 * (docs/index-spec.md §6.1). Geometry is CSS (the frame's host, checked against
 * the running app in e2e/index-sheets.spec.ts); this holds what a sheet must do
 * for a keyboard and a screen reader.
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

  it('opens in the sheet host inside main when there is one, and in the window when there is not', () => {
    const host = document.createElement('div');
    host.id = IX_SHEET_HOST_ID;
    document.body.appendChild(host);
    const { unmount } = render(<Host />);
    expect(host).toContainElement(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-host', 'pane');
    expect(screen.getByRole('dialog')).toHaveClass('ix-sheet');
    unmount();
    host.remove();

    render(<Host />);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-host', 'window');
  });

  it('is the whole screen on a phone, even with a host on the page', () => {
    mobile.value = true;
    const host = document.createElement('div');
    host.id = IX_SHEET_HOST_ID;
    document.body.appendChild(host);
    render(<Host />);
    expect(host).not.toContainElement(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-host', 'window');
  });

  it('draws no call pill: the call lives in the sidebar card', () => {
    render(<Host />);
    expect(screen.getByRole('dialog').querySelector('[class*="pill"]')).toBeNull();
  });

  it('closes on its own beat: it stays for the 250ms leave, out of the accessibility tree', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Close the sheet' }));
    // Still mounted while it plays its leave, but scenery: hidden and inert.
    const leaving = document.querySelector('.ix-sheet');
    expect(leaving).toHaveClass('is-leaving');
    expect(leaving).toHaveAttribute('aria-hidden', 'true');
    await vi.waitFor(() => expect(document.querySelector('.ix-sheet')).toBeNull(), { timeout: 1500 });
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
