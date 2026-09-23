import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../api/auth';
import { RegisterPage, registerStepError, registrationUnavailable } from './RegisterPage';

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
        <Route path="/setup-server" element={<div>Set up your Paracord instance</div>} />
      </Routes>
    </MemoryRouter>,
  );
}


const continueButton = () => screen.getByRole('button', { name: 'Continue' });
const createButton = () => screen.getByRole('button', { name: 'Create account' });

type User = ReturnType<typeof userEvent.setup>;

/** Step 1 → step 2. */
async function passIdentity(
  user: User,
  fields: { email?: string; displayName?: string; username?: string } = {},
) {
  if (fields.email) await user.type(screen.getByLabelText(/Email/), fields.email);
  if (fields.displayName) await user.type(screen.getByLabelText(/Display name/), fields.displayName);
  await user.type(screen.getByLabelText(/Username/), fields.username ?? 'ada');
  await user.click(continueButton());
}

/** Fill step 2 without submitting it. */
async function fillPassword(user: User, password: string, confirm = password, agree = true) {
  await user.type(await screen.findByLabelText(/^Password/), password);
  await user.type(screen.getByLabelText(/Confirm password/), confirm);
  if (agree) await user.click(screen.getByLabelText(/I have read and agree/));
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

    expect(await screen.findByText('Set up your Paracord instance')).toBeInTheDocument();
  });

  it('stays on registration when the setup check fails, rather than guessing', async () => {
    mockGetSetupStatus.mockRejectedValue(new Error('offline'));

    renderRegisterPage();

    await waitFor(() => expect(mockGetSetupStatus).toHaveBeenCalled());
    expect(continueButton()).toBeInTheDocument();
  });

  it('explains the password requirements on the step that asks for one', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    await passIdentity(user);

    const hint = await screen.findByText(/10–128 bytes/);
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

    await passIdentity(user);
    await fillPassword(user, password);
    await user.click(createButton());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mockAuthState.register).not.toHaveBeenCalled();
  });

  it('blocks registration when password confirmation does not match', async () => {
    const user = userEvent.setup();

    renderRegisterPage();

    await passIdentity(user);
    await fillPassword(user, VALID_PASSWORD, 'DifferentPass1!');
    await user.click(createButton());

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    // One message per field: the rejection replaces the gentler "not yet" the
    // field carried while it was still being typed into, rather than stacking
    // a second sentence that says the same thing.
    expect(screen.getByLabelText(/Confirm password/)).toHaveAccessibleDescription(
      'Passwords do not match.',
    );
    expect(screen.getByLabelText(/Confirm password/)).toHaveAttribute('aria-invalid', 'true');
    expect(mockAuthState.register).not.toHaveBeenCalled();
  });

  it.each([' ValidPass1! ', 'Aa1!ééé'])('passes an accepted password to register without trimming or a different character limit', async password => {
    const user = userEvent.setup();

    renderRegisterPage();

    await passIdentity(user);
    await fillPassword(user, password);
    await user.click(createButton());

    await waitFor(() => {
      expect(mockAuthState.register).toHaveBeenCalledWith('', 'ada', password, '', undefined);
    });
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });

  it('trims account fields and opens the app without duplicating the home session', async () => {
    const user = userEvent.setup();

    renderRegisterPage();

    await passIdentity(user, {
      email: 'ada@example.test',
      displayName: '  Ada Lovelace  ',
      username: '  ada  ',
    });
    await fillPassword(user, VALID_PASSWORD);
    await user.click(createButton());

    await waitFor(() => {
      expect(mockAuthState.register).toHaveBeenCalledWith(
        'ada@example.test',
        'ada',
        VALID_PASSWORD,
        'Ada Lovelace',
        undefined,
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

    await passIdentity(user);
    await fillPassword(user, VALID_PASSWORD);
    await user.click(createButton());

    expect(await screen.findByText('App shell')).toBeInTheDocument();
    expect(legacyAttachment).not.toHaveBeenCalled();
    expect(mockServerListState.addServer).not.toHaveBeenCalled();
  });
  it('asks who you are first, then the password, and counts the steps', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Confirm password/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toHaveFocus();

    await passIdentity(user, { email: 'ada@example.test' });

    expect(await screen.findByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/)).toHaveFocus();
    expect(createButton()).toBeInTheDocument();
  });

  it('keeps what was typed when stepping back', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    await passIdentity(user, { email: 'ada@example.test', displayName: 'Ada' });
    await fillPassword(user, VALID_PASSWORD, VALID_PASSWORD, false);
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(await screen.findByLabelText(/Email/)).toHaveValue('ada@example.test');
    expect(screen.getByLabelText(/Display name/)).toHaveValue('Ada');

    await user.click(continueButton());
    expect(await screen.findByLabelText(/^Password/)).toHaveValue(VALID_PASSWORD);
  });

  it('refuses to leave the first step without a username, and says so on the field', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    await user.click(continueButton());

    expect(await screen.findByText('Username is required.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Username/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
  });

  it('says a confirmation does not match yet while it is still being typed', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    await passIdentity(user);
    await fillPassword(user, VALID_PASSWORD, 'Different', false);

    expect(screen.getByLabelText(/Confirm password/)).toHaveAccessibleDescription(
      'These passwords don’t match yet.',
    );
  });

  it('will not create the account until the terms are agreed to', async () => {
    const user = userEvent.setup();
    renderRegisterPage();

    await passIdentity(user);
    await fillPassword(user, VALID_PASSWORD, VALID_PASSWORD, false);
    await user.click(createButton());

    expect(await screen.findByText('You must agree to the terms of service')).toBeInTheDocument();
    expect(mockAuthState.register).not.toHaveBeenCalled();
  });
});

describe('RegisterPage on an invite-only server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockAuthState.register.mockResolvedValue(undefined);
    mockGetSetupStatus.mockResolvedValue({ data: { setup_required: false } });
    vi.mocked(authApi.options).mockResolvedValue({
      data: {
        allow_username_login: true,
        require_email: false,
        registration_enabled: true,
        registration_mode: 'invite_only',
      },
    } as never);
  });

  it('says so plainly instead of showing a form that will fail', async () => {
    renderRegisterPage();

    expect(
      await screen.findByText(
        'This server is invite-only. Ask the person who runs it for an invite link.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in instead' })).toHaveAttribute('href', '/login');
  });

  it('shows the form to someone who came from an invite, and sends the invite along', async () => {
    sessionStorage.setItem('paracord:pending-invite', 'abc123');
    const user = userEvent.setup();
    renderRegisterPage();

    await passIdentity(user);
    await fillPassword(user, VALID_PASSWORD);
    await user.click(createButton());

    await waitFor(() => {
      expect(mockAuthState.register).toHaveBeenCalledWith('', 'ada', VALID_PASSWORD, '', 'abc123');
    });
    // Consumed once the account exists, and the person goes on to join.
    expect(sessionStorage.getItem('paracord:pending-invite')).toBeNull();
  });
});

describe('registrationUnavailable', () => {
  it('lets an open server, or an invite-only one with an invite, show the form', () => {
    expect(
      registrationUnavailable({ registrationEnabled: true, registrationMode: 'open', hasInvite: false }),
    ).toBeNull();
    expect(
      registrationUnavailable({
        registrationEnabled: true,
        registrationMode: 'invite_only',
        hasInvite: true,
      }),
    ).toBeNull();
  });

  it('explains a closed server and an invite-only one without an invite', () => {
    expect(
      registrationUnavailable({ registrationEnabled: false, registrationMode: 'open', hasInvite: true }),
    ).toMatchObject({ title: 'Sign-ups are closed' });
    expect(
      registrationUnavailable({
        registrationEnabled: true,
        registrationMode: 'invite_only',
        hasInvite: false,
      }),
    ).toMatchObject({ title: 'You need an invite' });
  });
});

describe('registerStepError', () => {
  const draft = {
    email: '',
    displayName: '',
    username: 'ada',
    password: VALID_PASSWORD,
    confirmPassword: VALID_PASSWORD,
    agreed: true,
  };

  it('passes a complete draft at both steps', () => {
    expect(registerStepError('identity', draft, { requireEmail: false })).toBeNull();
    expect(registerStepError('password', draft, { requireEmail: false })).toBeNull();
  });

  it('names the field a rejection belongs to', () => {
    expect(registerStepError('identity', { ...draft, username: ' ' }, { requireEmail: false }))
      .toMatchObject({ field: 'username' });
    expect(registerStepError('identity', { ...draft, email: 'nope' }, { requireEmail: false }))
      .toMatchObject({ field: 'email' });
    expect(registerStepError('identity', draft, { requireEmail: true }))
      .toMatchObject({ field: 'email' });
    expect(registerStepError('password', { ...draft, confirmPassword: 'x' }, { requireEmail: false }))
      .toMatchObject({ field: 'confirmPassword' });
    expect(registerStepError('password', { ...draft, agreed: false }, { requireEmail: false }))
      .toMatchObject({ field: 'agreed' });
  });
});
