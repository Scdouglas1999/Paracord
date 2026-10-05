import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from './AdminPage';

const mockAuthState = vi.hoisted(() => ({
  user: null as { id: string; flags: number } | null,
}));

vi.mock('../stores/authStore', () => {
  const useAuthStore = Object.assign(
    (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
    { getState: vi.fn(() => mockAuthState) },
  );
  return { useAuthStore };
});

// Stub the panels so the page's access control + tab routing is tested in
// isolation, without the panels' own data fetching.
vi.mock('./admin/OverviewPanel', () => ({ OverviewPanel: () => <div>Overview panel body</div> }));
vi.mock('./admin/UsersPanel', () => ({ UsersPanel: () => <div>Users panel body</div> }));
vi.mock('./admin/GuildsPanel', () => ({ GuildsPanel: () => <div>Servers panel body</div> }));
vi.mock('./admin/SettingsPanel', () => ({ SettingsPanel: () => <div>Settings panel body</div> }));
vi.mock('./admin/FederationPanel', () => ({ FederationPanel: () => <div>Federation panel body</div> }));
vi.mock('./admin/SecurityPanel', () => ({ SecurityPanel: () => <div>Security panel body</div> }));
vi.mock('./admin/BackupsPanel', () => ({ BackupsPanel: () => <div>Backups panel body</div> }));

function renderAdminPage() {
  render(
    <MemoryRouter initialEntries={['/app/admin']}>
      <Routes>
        <Route path="/app/admin" element={<AdminPage />} />
        <Route path="/app" element={<div>Last place route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.user = null;
    // jsdom has no media-query engine; pages ask for the phone breakpoint.
    // Desktop (no match) is the layout these assertions describe.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('shows a loading state while the current user is unresolved', () => {
    renderAdminPage();

    expect(screen.getByText('Checking admin access...')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('denies non-admins and sends them back from the access-denied state', async () => {
    const user = userEvent.setup();
    mockAuthState.user = { id: 'user-1', flags: 0 };

    renderAdminPage();

    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('Overview panel body')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));

    // `/app` opens the place you were in (Home is retired).
    expect(screen.getByText('Last place route')).toBeInTheDocument();
  });

  it('renders the overview panel by default for admins', () => {
    mockAuthState.user = { id: 'admin-1', flags: 1 };

    renderAdminPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Administration sections' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/Back to home/)).toBeNull();
    expect(screen.getByText('Overview panel body')).toBeInTheDocument();
    expect(screen.queryByText('Users panel body')).not.toBeInTheDocument();
  });

  it('switches the active panel when a section is selected', async () => {
    const user = userEvent.setup();
    mockAuthState.user = { id: 'admin-1', flags: 1 };

    renderAdminPage();

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    expect(screen.getByText('Users panel body')).toBeInTheDocument();
    expect(screen.queryByText('Overview panel body')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Security' }));
    expect(screen.getByText('Security panel body')).toBeInTheDocument();
    expect(screen.queryByText('Users panel body')).not.toBeInTheDocument();
  });

  it('moves between sections with the arrow keys (one tab stop)', async () => {
    const user = userEvent.setup();
    mockAuthState.user = { id: 'admin-1', flags: 1 };

    renderAdminPage();

    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Users' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Users panel body')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('tabindex', '-1');
  });

  it('Escape goes back to the last place', async () => {
    const user = userEvent.setup();
    mockAuthState.user = { id: 'admin-1', flags: 1 };

    renderAdminPage();

    await user.keyboard('{Escape}');
    expect(screen.getByText('Last place route')).toBeInTheDocument();
  });
});
