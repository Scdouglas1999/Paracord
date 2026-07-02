import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { CommandPalette } from './CommandPalette';

vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...props}>
            {children}
          </div>
        ),
      ),
    },
  };
});

describe('CommandPalette accessibility', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    useUIStore.setState({ commandPaletteOpen: false });
  });

  afterEach(() => {
    act(() => {
      useUIStore.setState({ commandPaletteOpen: false });
    });
  });

  async function renderOpenPalette() {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <button type="button">Open palette</button>
        <CommandPalette />
      </MemoryRouter>,
    );
    screen.getByRole('button', { name: 'Open palette' }).focus();
    await user.keyboard('{Control>}k{/Control}');
  }

  it('opens as a named modal dialog and focuses the search field', async () => {
    await renderOpenPalette();

    const dialog = screen.getByRole('dialog', { name: 'Command Palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('tabindex', '-1');

    const search = screen.getByRole('textbox', { name: 'Search command palette' });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('traps Tab focus and restores focus after Escape closes it', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <button type="button">Open palette</button>
        <CommandPalette />
      </MemoryRouter>,
    );

    const opener = screen.getByRole('button', { name: 'Open palette' });
    opener.focus();
    await user.keyboard('{Control>}k{/Control}');

    const dialog = await screen.findByRole('dialog', { name: 'Command Palette' });
    const search = screen.getByRole('textbox', { name: 'Search command palette' });
    await waitFor(() => expect(search).toHaveFocus());

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command Palette' })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
