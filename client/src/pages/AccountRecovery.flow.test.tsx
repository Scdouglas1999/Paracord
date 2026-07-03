import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountStore } from '../stores/accountStore';
import { AccountRecoverPage } from './AccountRecoverPage';
import { AccountSetupPage } from './AccountSetupPage';

const mockAccountState = vi.hoisted(() => ({
  create: vi.fn(),
  recover: vi.fn(),
  getRecoveryPhrase: vi.fn(),
  publicKey: 'public-key',
}));

vi.mock('../stores/accountStore', () => ({
  useAccountStore: (selector: (state: typeof mockAccountState) => unknown) =>
    selector(mockAccountState),
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({
      user: null,
      token: null,
    })),
  },
}));

vi.mock('../stores/serverListStore', () => ({
  useServerListStore: {
    getState: vi.fn(() => ({
      addServer: vi.fn(),
    })),
  },
}));

vi.mock('../api/auth', () => ({
  authApi: {
    attachPublicKey: vi.fn(),
  },
}));

vi.mock('../lib/config/apiBaseUrl', () => ({
  getCurrentOriginServerUrl: vi.fn(() => null),
  getStoredServerUrl: vi.fn(() => null),
  setStoredServerUrl: vi.fn(),
}));

const recoveryPhrase = Array.from({ length: 24 }, (_, index) => `word${index + 1}`).join(' ');

function renderSetupPage(initialEntry = '/setup') {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/setup" element={<AccountSetupPage />} />
        <Route path="/connect" element={<div>Connect server</div>} />
        <Route path="/app" element={<div>App shell</div>} />
        <Route path="/recover" element={<AccountRecoverPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderRecoverPage() {
  render(
    <MemoryRouter initialEntries={['/recover']}>
      <Routes>
        <Route path="/recover" element={<AccountRecoverPage />} />
        <Route path="/app" element={<div>App shell</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Account recovery setup flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountState.create.mockResolvedValue(undefined);
    mockAccountState.recover.mockResolvedValue(undefined);
    mockAccountState.getRecoveryPhrase.mockReturnValue(recoveryPhrase);
  });

  it('creates a local identity, displays the recovery phrase, and requires acknowledgement before continuing', async () => {
    const user = userEvent.setup();

    renderSetupPage();

    await user.type(screen.getByLabelText(/Username/), 'alice');
    await user.type(screen.getByLabelText(/Display Name/), 'Alice');
    await user.type(screen.getByLabelText(/^Password/), 'StrongPass123!');
    await user.type(screen.getByLabelText(/Confirm Password/), 'StrongPass123!');
    await user.click(screen.getByRole('button', { name: 'Create Identity' }));

    await waitFor(() =>
      expect(useAccountStore((state) => state.create)).toHaveBeenCalledWith(
        'alice',
        'StrongPass123!',
        'Alice',
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Recovery Phrase' })).toBeInTheDocument();
    expect(screen.getByText('word1')).toBeInTheDocument();
    expect(screen.getByText('word24')).toBeInTheDocument();

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);

    expect(await screen.findByText('Connect server')).toBeInTheDocument();
  });

  it('trims local identity names before creating the account', async () => {
    const user = userEvent.setup();

    renderSetupPage();

    await user.type(screen.getByLabelText(/Username/), '  alice  ');
    await user.type(screen.getByLabelText(/Display Name/), '  Alice Example  ');
    await user.type(screen.getByLabelText(/^Password/), 'StrongPass123!');
    await user.type(screen.getByLabelText(/Confirm Password/), 'StrongPass123!');
    await user.click(screen.getByRole('button', { name: 'Create Identity' }));

    await waitFor(() =>
      expect(useAccountStore((state) => state.create)).toHaveBeenCalledWith(
        'alice',
        'StrongPass123!',
        'Alice Example',
      ),
    );
  });

  it('validates recovery phrase shape before recovering an account', async () => {
    const user = userEvent.setup();

    renderRecoverPage();

    await user.type(screen.getByLabelText(/Recovery Phrase/), 'too short');
    await user.type(screen.getByLabelText(/Username/), 'alice');
    await user.type(screen.getByLabelText(/^New Password/), 'StrongPass123!');
    await user.type(screen.getByLabelText(/Confirm Password/), 'StrongPass123!');
    await user.click(screen.getByRole('button', { name: 'Recover Account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Recovery phrase must be exactly 24 words.');
    expect(useAccountStore((state) => state.recover)).not.toHaveBeenCalled();
  });

  it('recovers an account from a valid phrase and navigates to the app', async () => {
    const user = userEvent.setup();

    renderRecoverPage();

    await user.type(screen.getByLabelText(/Recovery Phrase/), recoveryPhrase);
    await user.type(screen.getByLabelText(/Username/), '  alice  ');
    await user.type(screen.getByLabelText(/^New Password/), 'StrongPass123!');
    await user.type(screen.getByLabelText(/Confirm Password/), 'StrongPass123!');
    await user.click(screen.getByRole('button', { name: 'Recover Account' }));

    await waitFor(() =>
      expect(useAccountStore((state) => state.recover)).toHaveBeenCalledWith(
        recoveryPhrase,
        'alice',
        'StrongPass123!',
      ),
    );
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });
});
