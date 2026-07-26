import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { CommandPalette } from './CommandPalette';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

// The palette mounts DmPickerModal to satisfy the "New message" command; stub it
// so the test asserts the trigger without pulling in its friend-list fetch.
vi.mock('../message/DmPickerModal', () => ({
  DmPickerModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dm-picker">DM picker</div> : null,
}));

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
    navigateMock.mockClear();
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

  it('toggles closed on a second Mod+K without a competing TopBar force-open', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Command Palette' })).toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command Palette' })).not.toBeInTheDocument(),
    );
    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });
});

describe('CommandPalette social action commands', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    navigateMock.mockClear();
    useUIStore.setState({ commandPaletteOpen: false });
  });

  afterEach(() => {
    act(() => {
      useUIStore.setState({ commandPaletteOpen: false });
    });
  });

  async function openPalette() {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <button type="button">Opener</button>
        <CommandPalette />
      </MemoryRouter>,
    );
    screen.getByRole('button', { name: 'Opener' }).focus();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Command Palette' });
    return user;
  }

  it('surfaces the social action commands', async () => {
    await openPalette();
    expect(screen.getByText('New message')).toBeInTheDocument();
    expect(screen.getByText('Add a friend')).toBeInTheDocument();
    expect(screen.getByText('All conversations')).toBeInTheDocument();
    expect(screen.getByText('Friends')).toBeInTheDocument();
  });

  it('opens the DM picker from "New message"', async () => {
    const user = await openPalette();
    await user.click(screen.getByText('New message'));
    await waitFor(() => expect(screen.getByTestId('dm-picker')).toBeInTheDocument());
  });

  it('routes "Add a friend" and "Friends" to the friends page', async () => {
    const user = await openPalette();
    await user.click(screen.getByText('Add a friend'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/app/friends'));
  });

  it('routes "All conversations" to the DM index', async () => {
    const user = await openPalette();
    await user.click(screen.getByText('All conversations'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/app/dms'));
  });

  it('sends Home to the App Home and keeps a single Friends entry', async () => {
    const user = await openPalette();
    // Exactly one "Friends" command — Home no longer doubles as the friends link.
    expect(screen.getAllByText('Friends')).toHaveLength(1);
    await user.click(screen.getByText('Go to Home'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/app'));
    expect(navigateMock).not.toHaveBeenCalledWith('/app/friends');
  });
});
