import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getVersionedStorageItem,
  setVersionedStorageItem,
} from '../../lib/versionedStorage';
import { LayoutTour } from './LayoutTour';

// Reduced-motion-agnostic stub: render motion.div as a plain div so the coach-mark
// is present synchronously (mirrors CommandPalette.test).
vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
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

const SHELL_KEY = 'layout-tour-shell';
const GUILD_KEY = 'layout-tour-guild-home';
const TOUR = { name: 'Get to know your workspace' };

/** jsdom gives every element a zero rect; the tour needs a laid-out anchor. */
function stubLayout() {
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        top: 100,
        left: 0,
        right: 280,
        bottom: 600,
        width: 280,
        height: 500,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

function ShellAnchors() {
  return (
    <aside aria-label="Navigation">
      <button type="button" aria-label="Search — open command palette">
        Search
      </button>
    </aside>
  );
}

function RoomsAnchor() {
  return (
    <>
      <ShellAnchors />
      <section aria-label="Live rooms">rooms</section>
    </>
  );
}

describe('LayoutTour', () => {
  beforeEach(() => {
    localStorage.clear();
    stubLayout();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('runs the shell tour: sidebar, then search, then persists on Done', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/app']}>
        <ShellAnchors />
        <LayoutTour />
      </MemoryRouter>,
    );

    // Step (a) — the unified sidebar region.
    await screen.findByText(/Everything that needs you/i);
    expect(getVersionedStorageItem(SHELL_KEY)).toBeNull();

    // Advance to step (b) — the search / ⌘K entry.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(/Jump anywhere instantly/i);

    // Finish — the last step shows "Done" and persists dismissal.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: TOUR.name })).not.toBeInTheDocument(),
    );
    expect(getVersionedStorageItem(SHELL_KEY)).toBe('done');
  });

  it('ends the whole tour on "Skip tour"', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/app']}>
        <ShellAnchors />
        <LayoutTour />
      </MemoryRouter>,
    );

    await screen.findByText(/Everything that needs you/i);
    await user.click(screen.getByRole('button', { name: 'Skip tour' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: TOUR.name })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Jump anywhere instantly/i)).not.toBeInTheDocument();
    expect(getVersionedStorageItem(SHELL_KEY)).toBe('done');
  });

  it('dismisses on Escape and persists', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/app']}>
        <ShellAnchors />
        <LayoutTour />
      </MemoryRouter>,
    );

    const dialog = await screen.findByRole('dialog', { name: TOUR.name });
    await waitFor(() => expect(dialog).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: TOUR.name })).not.toBeInTheDocument(),
    );
    expect(getVersionedStorageItem(SHELL_KEY)).toBe('done');
  });

  it('does not re-run once the shell tour is persisted', async () => {
    setVersionedStorageItem(SHELL_KEY, 'done');
    render(
      <MemoryRouter initialEntries={['/app']}>
        <ShellAnchors />
        <LayoutTour />
      </MemoryRouter>,
    );

    await Promise.resolve();
    expect(screen.queryByRole('dialog', { name: TOUR.name })).not.toBeInTheDocument();
  });

  it('shows the rooms step on the first guild-home visit', async () => {
    // Shell tour already done — the guild-home step is independently gated.
    setVersionedStorageItem(SHELL_KEY, 'done');
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/app/guilds/123']}>
        <RoomsAnchor />
        <LayoutTour />
      </MemoryRouter>,
    );

    await screen.findByText(/jump into a room or pick a channel/i);
    expect(getVersionedStorageItem(GUILD_KEY)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: TOUR.name })).not.toBeInTheDocument(),
    );
    expect(getVersionedStorageItem(GUILD_KEY)).toBe('done');
  });

  it('shows nothing when no anchor is present', async () => {
    render(
      <MemoryRouter initialEntries={['/app']}>
        <LayoutTour />
      </MemoryRouter>,
    );

    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByRole('dialog', { name: TOUR.name })).not.toBeInTheDocument();
    expect(getVersionedStorageItem(SHELL_KEY)).toBeNull();
  });
});
