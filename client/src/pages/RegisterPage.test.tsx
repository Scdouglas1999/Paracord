import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../api/auth';
import { RegisterPage } from './RegisterPage';

const mockAuthState = vi.hoisted(() => ({
  token: 'access-token' as string | null,
  register: vi.fn(),
}));

const mockAccountState = vi.hoisted(() => ({
  isUnlocked: false,
  publicKey: null as string | null,
}));

const mockServerListState = vi.hoisted(() => ({
  getServerByUrl: vi.fn(),
  addServer: vi.fn(),
  updateToken: vi.fn(),
  updateRefreshToken: vi.fn(),
}));

const mockApiBaseUrl = vi.hoisted(() => ({
  getStoredServerUrl: vi.fn(() => 'https://chat.example.test'),
  getCurrentOriginServerUrl: vi.fn(() => null),
  setStoredServerUrl: vi.fn(),
}));

const mockHasAccount = vi.hoisted(() => vi.fn(() => false));

const legacyAttachment = vi.hoisted(() => vi.fn());

const mockGetSetupStatus = vi.hoisted(() => vi.fn());

// Meets the real server policy: 10+ UTF-8 bytes with ASCII upper, lower,
// digit, and a non-alphanumeric ASCII character.
const VALID_PASSWORD = 'ValidPass123!';

vi.mock('../api/auth', () => ({
  authApi: {
    options: vi.fn(),
    attachPublicKey: legacyAttachment,
  },
}));

vi.mock('../api/client', () => ({
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'Registration failed'),
}));

vi.mock('../api/instance', () => ({
  instanceApi: {
    getSetupStatus: mockGetSetupStatus,
  },
}));

vi.mock('../stores/authStore', () => {
  const useAuthStore = Object.assign(
    (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
    {
      getState: vi.fn(() => mockAuthState),
    },
  );
  return { useAuthStore };
});

vi.mock('../stores/accountStore', () => ({
  useAccountStore: {
    getState: vi.fn(() => mockAccountState),
  },
}));

vi.mock('../stores/serverListStore', () => ({
  useServerListStore: {
    getState: vi.fn(() => mockServerListState),
  },
}));

vi.mock('../lib/config/apiBaseUrl', () => mockApiBaseUrl);

vi.mock('../lib/account', () => ({
  hasAccount: mockHasAccount,
}));

function renderRegisterPage() {
  render(
    <MemoryRouter initialEntries={['/register']}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/app" element={<div>App shell</div>} />
        <Route path="/login" element={<div>Login page</div>} />
        <Route path="/terms" element={<div>Terms</div>} />
        <Route path="/privacy" element={<div>Privacy</div>} />
        <Route path="/setup-server" element={<div>Set up your Paracord server</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.token = 'access-token';
    mockAuthState.register.mockResolvedValue(undefined);
    mockAccountState.isUnlocked = false;
    mockAccountState.publicKey = null;
    mockServerListState.getServerByUrl.mockReturnValue(null);
    mockApiBaseUrl.getStoredServerUrl.mockReturnValue('https://chat.example.test');
    mockApiBaseUrl.getCurrentOriginServerUrl.mockReturnValue(null);
    mockHasAccount.mockReturnValue(false);
    vi.mocked(authApi.options).mockResolvedValue({
      data: { allow_username_login: true, require_email: false },
    } as never);
    legacyAttachment.mockResolvedValue({ data: {} } as never);
    mockGetSetupStatus.mockResolvedValue({ data: { setup_required: false } });
  });

  it('sends the operator to the claim flow when the server has no owner yet', async () => {
    mockGetSetupStatus.mockResolvedValue({
      data: { setup_required: true },
    });

    renderRegisterPage();

    expect(await screen.findByText('Set up your Paracord server')).toBeInTheDocument();
  });

  it('stays on registration when the setup check fails, rather than guessing', async () => {
    mockGetSetupStatus.mockRejectedValue(new Error('offline'));

    renderRegisterPage();

    await waitFor(() => expect(mockGetSetupStatus).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('explains the password requirements before typing', () => {
    renderRegisterPage();

    const hint = screen.getByText(/10–128 bytes/);
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toMatch(/uppercase letter \(A–Z\)/);
    expect(hint.textContent).toMatch(/lowercase letter \(a–z\)/);
    expect(hint.textContent).toMatch(/digit \(0–9\)/);
    expect(hint.textContent).toMatch(/ASCII symbol.*or space/);
    expect(screen.getByLabelText(/^Password/)).toHaveAccessibleDescription(hint.textContent!);
    expect(screen.getByLabelText(/^Password/)).not.toHaveAttribute('minlength');
  });

  it.each([
    ['an uppercase letter', 'aa1!bcdefg', 'Password must include an uppercase letter (A–Z).'],
    ['a lowercase letter', 'AA1!BCDEFG', 'Password must include a lowercase letter (a–z).'],
    ['a digit', 'Aa!!bcdefg', 'Password must include a digit (0–9).'],
    ['a symbol or space', 'Aa1bcdefgh', 'Password must include a symbol or space.'],
  ])('blocks registration when the password lacks %s', async (_missing, password, message) => {
    const user = userEvent.setup();

    renderRegisterPage();

    await user.type(screen.getByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/^Password/), password);
    await user.type(screen.getByLabelText(/Confirm password/), password);
    await user.click(screen.getByLabelText(/I have read and agree/));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mockAuthState.register).not.toHaveBeenCalled();
  });

  it('blocks registration when password confirmation does not match', async () => {
    const user = userEvent.setup();

    renderRegisterPage();

    await user.type(screen.getByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/^Password/), VALID_PASSWORD);
    await user.type(screen.getByLabelText(/Confirm password/), 'DifferentPass1!');
    await user.click(screen.getByLabelText(/I have read and agree/));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Confirm password/)).toHaveAccessibleDescription('These passwords don’t match yet.');
    expect(screen.getByLabelText(/Confirm password/)).toHaveAttribute('aria-invalid', 'true');
    expect(mockAuthState.register).not.toHaveBeenCalled();
  });

  it.each([' ValidPass1! ', 'Aa1!ééé'])('passes an accepted password to register without trimming or a different character limit', async password => {
    const user = userEvent.setup();

    renderRegisterPage();

    await user.type(screen.getByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/^Password/), password);
    await user.type(screen.getByLabelText(/Confirm password/), password);
    await user.click(screen.getByLabelText(/I have read and agree/));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockAuthState.register).toHaveBeenCalledWith('', 'ada', password, '');
    });
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });

  it('trims account fields and opens the app without duplicating the home session', async () => {
    const user = userEvent.setup();

    renderRegisterPage();

    await user.type(screen.getByLabelText(/Email/), 'ada@example.test');
    await user.type(screen.getByLabelText(/Display name/), '  Ada Lovelace  ');
    await user.type(screen.getByLabelText(/Username/), '  ada  ');
    await user.type(screen.getByLabelText(/^Password/), VALID_PASSWORD);
    await user.type(screen.getByLabelText(/Confirm password/), VALID_PASSWORD);
    await user.click(screen.getByLabelText(/I have read and agree/));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockAuthState.register).toHaveBeenCalledWith(
        'ada@example.test',
        'ada',
        VALID_PASSWORD,
        'Ada Lovelace',
      );
    });
    expect(mockServerListState.addServer).not.toHaveBeenCalled();
    expect(mockServerListState.updateToken).not.toHaveBeenCalled();
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });

  it('keeps registration credentials when a local identity is already unlocked', async () => {
    const user = userEvent.setup();
    mockHasAccount.mockReturnValue(true);
    mockAccountState.isUnlocked = true;
    mockAccountState.publicKey = 'public-key-1';

    renderRegisterPage();

    await user.type(screen.getByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/^Password/), VALID_PASSWORD);
    await user.type(screen.getByLabelText(/Confirm password/), VALID_PASSWORD);
    await user.click(screen.getByLabelText(/I have read and agree/));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('App shell')).toBeInTheDocument();
    expect(legacyAttachment).not.toHaveBeenCalled();
    expect(mockServerListState.addServer).not.toHaveBeenCalled();
  });
});
