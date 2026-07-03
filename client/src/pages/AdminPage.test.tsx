import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

// Stub the panels so the shell's access control + tab routing is tested in
// isolation, without the panels' own data fetching.
vi.mock('./admin/OverviewPanel', () => ({ OverviewPanel: () => <div>Overview panel body</div> }));
vi.mock('./admin/UsersPanel', () => ({ UsersPanel: () => <div>Users panel body</div> }));
vi.mock('./admin/GuildsPanel', () => ({ GuildsPanel: () => <div>Guilds panel body</div> }));
vi.mock('./admin/SettingsPanel', () => ({ SettingsPanel: () => <div>Settings panel body</div> }));
vi.mock('./admin/FederationPanel', () => ({ FederationPanel: () => <div>Federation panel body</div> }));
vi.mock('./admin/SecurityPanel', () => ({ SecurityPanel: () => <div>Security panel body</div> }));
vi.mock('./admin/BackupsPanel', () => ({ BackupsPanel: () => <div>Backups panel body</div> }));

function renderAdminPage() {
  render(
    <MemoryRouter initialEntries={['/app/admin']}>
      <Routes>
        <Route path="/app/admin" element={<AdminPage />} />
        <Route path="/app" element={<div>Home route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.user = null;
  });

  it('shows a loading state while the current user is unresolved', () => {
    renderAdminPage();

    expect(screen.getByText('Checking admin access...')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('denies non-admins and routes them home from the access-denied screen', async () => {
    const user = userEvent.setup();
    mockAuthState.user = { id: 'user-1', flags: 0 };

    renderAdminPage();

    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('Overview panel body')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go Back' }));

    expect(screen.getByText('Home route')).toBeInTheDocument();
  });

  it('renders the overview panel by default for admins', () => {
    mockAuthState.user = { id: 'admin-1', flags: 1 };

    renderAdminPage();

    expect(screen.getByRole('heading', { name: 'Admin' })).toBeInTheDocument();
    expect(screen.getByText('Overview panel body')).toBeInTheDocument();
    expect(screen.queryByText('Users panel body')).not.toBeInTheDocument();
  });

  it('switches the active panel when a sidebar tab is selected', async () => {
    const user = userEvent.setup();
    mockAuthState.user = { id: 'admin-1', flags: 1 };

    renderAdminPage();

    await user.click(screen.getByRole('button', { name: 'Users' }));
    expect(screen.getByText('Users panel body')).toBeInTheDocument();
    expect(screen.queryByText('Overview panel body')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Security' }));
    expect(screen.getByText('Security panel body')).toBeInTheDocument();
    expect(screen.queryByText('Users panel body')).not.toBeInTheDocument();
  });
});
