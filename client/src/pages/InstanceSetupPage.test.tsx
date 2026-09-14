import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceSetupPage, claimStepError, passwordRulesMismatch } from './InstanceSetupPage';

const mockGetSetupStatus = vi.hoisted(() => vi.fn());
const mockGetPasswordRequirements = vi.hoisted(() => vi.fn());
const mockClaimInstance = vi.hoisted(() => vi.fn());
const mockAuthOptions = vi.hoisted(() => vi.fn());
const mockFetchUser = vi.hoisted(() => vi.fn());
const mockSetState = vi.hoisted(() => vi.fn());
const mockSetAccessToken = vi.hoisted(() => vi.fn());
const mockSetRefreshToken = vi.hoisted(() => vi.fn());

// Meets the real server policy: 10+ UTF-8 bytes with ASCII upper, lower, digit
// and a non-alphanumeric ASCII character.
const VALID_PASSWORD = 'ValidPass123!';
const CLAIM_TOKEN = 'A1B2C3D4E5F6G7H8J9K0MNPQRSTVWXYZ23456789ABCDEFGHJKMN';

const SERVER_REQUIREMENTS = {
  min_length: 10,
  max_length: 128,
  requires_uppercase: true,
  requires_lowercase: true,
  requires_digit: true,
  requires_symbol: true,
  length_unit: 'utf8_bytes',
};

vi.mock('../api/instance', () => ({
  instanceApi: {
    getSetupStatus: mockGetSetupStatus,
    getPasswordRequirements: mockGetPasswordRequirements,
    claimInstance: mockClaimInstance,
  },
}));

vi.mock('../api/auth', () => ({
  authApi: { options: mockAuthOptions },
}));

vi.mock('../api/client', () => ({
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : ''),
}));

vi.mock('../lib/authToken', () => ({
  setAccessToken: mockSetAccessToken,
  setRefreshToken: mockSetRefreshToken,
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({}),
    {
      getState: () => ({ fetchUser: mockFetchUser }),
      setState: mockSetState,
    },
  ),
}));

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/setup-server']}>
      <Routes>
        <Route path="/setup-server" element={<InstanceSetupPage />} />
        <Route path="/login" element={<div>Welcome back</div>} />
        <Route path="/app/guilds/:guildId" element={<div>Server shell</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const continueButton = () => screen.getByRole('button', { name: 'Continue' });
const claimButton = () => screen.getByRole('button', { name: 'Claim this instance' });

type User = ReturnType<typeof userEvent.setup>;

/** Step 1 → step 2. */
async function passToken(user: User, token = CLAIM_TOKEN) {
  await user.type(await screen.findByLabelText(/Claim token/), token);
  await user.click(continueButton());
}

/** Step 2 → step 3. */
async function passOwner(user: User, username = 'ada') {
  await user.type(await screen.findByLabelText(/Username/), username);
  await user.click(continueButton());
}

/** Step 3 → step 4. */
async function passPassword(user: User, password = VALID_PASSWORD) {
  await user.type(await screen.findByLabelText(/^Password/), password);
  await user.type(screen.getByLabelText(/Confirm password/), password);
  await user.click(continueButton());
}

/** Everything up to, but not including, the claim itself. */
async function walkToLastStep(user: User) {
  await passToken(user);
  await passOwner(user);
  await passPassword(user);
  await user.type(await screen.findByLabelText(/Instance name/), 'Riverside Studio');
  await user.type(screen.getByLabelText(/First server name/), 'The Lounge');
}

describe('InstanceSetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetupStatus.mockResolvedValue({ data: { setup_required: true } });
    mockGetPasswordRequirements.mockResolvedValue({ data: SERVER_REQUIREMENTS });
    mockAuthOptions.mockResolvedValue({
      data: { allow_username_login: true, require_email: false },
    });
    mockFetchUser.mockResolvedValue(undefined);
  });

  it('distinguishes running the server from joining a community', async () => {
    renderPage();

    expect(await screen.findByText('Set up your Paracord instance')).toBeInTheDocument();
    expect(
      screen.getByText(/You’re setting up the instance itself, not joining one/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Joining someone else’s community instead\?/)).toBeInTheDocument();
  });

  it('explains where the claim token comes from before asking for it', async () => {
    renderPage();

    expect(await screen.findByText(/Prove you run this instance/)).toBeInTheDocument();
    expect(screen.getByText(/first-owner-claim\.txt/)).toBeInTheDocument();
    expect(
      screen.getByText(/Nobody can create an account here until this token is used/),
    ).toBeInTheDocument();
  });

  it('asks for one thing at a time, counted, with the action always on the plate', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Step 1 of 4')).toBeInTheDocument();
    // Only this step's field is on screen — the rest of the form is not below
    // a fold, it is not rendered yet.
    expect(screen.queryByLabelText(/Instance name/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Claim token/)).toHaveFocus();

    await passToken(user);
    expect(await screen.findByText('Step 2 of 4')).toBeInTheDocument();
    expect(screen.getByLabelText(/Username/)).toHaveFocus();
    expect(screen.queryByLabelText(/Claim token/)).not.toBeInTheDocument();

    await passOwner(user);
    expect(await screen.findByText('Step 3 of 4')).toBeInTheDocument();

    await passPassword(user);
    expect(await screen.findByText('Step 4 of 4')).toBeInTheDocument();
    // The last step is the one that claims, and says so.
    expect(claimButton()).toBeInTheDocument();
  });

  it('announces the step it moved to rather than changing silently', async () => {
    const user = userEvent.setup();
    renderPage();

    await passToken(user);

    const live = await screen.findByText('Step 2 of 4');
    const region = live.closest('[aria-live]');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Create the owner account');
  });

  it('refuses to leave a step whose field is wrong, and says so on the field', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText(/Claim token/);

    // Whitespace only: the `required` attribute accepts it, the server does not.
    await user.type(screen.getByLabelText(/Claim token/), '   ');
    await user.click(continueButton());

    expect(
      await screen.findByText(/Paste the claim token from your instance’s terminal/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Claim token/)).toHaveAttribute('aria-invalid', 'true');
    // Still on step 1.
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
  });

  it('withdraws a field rejection as soon as the field is edited', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText(/Claim token/);

    await user.click(continueButton());
    expect(await screen.findByText(/Paste the claim token/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Claim token/), CLAIM_TOKEN);
    await waitFor(() => expect(screen.queryByText(/Paste the claim token/)).not.toBeInTheDocument());
  });

  it('advances on Enter, exactly like the visible button', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/Claim token/), `${CLAIM_TOKEN}{Enter}`);

    expect(await screen.findByText('Step 2 of 4')).toBeInTheDocument();
  });

  it('shows the complete password requirements on the step that asks for one', async () => {
    const user = userEvent.setup();
    renderPage();

    await passToken(user);
    await passOwner(user);

    const hint = await screen.findByText(/10–128 bytes/);
    expect(hint.textContent).toMatch(/uppercase letter \(A–Z\)/);
    expect(hint.textContent).toMatch(/lowercase letter \(a–z\)/);
    expect(hint.textContent).toMatch(/digit \(0–9\)/);
    expect(hint.textContent).toMatch(/ASCII symbol.*or space/);
    expect(screen.getByLabelText(/^Password/)).toHaveAccessibleDescription(hint.textContent!);
  });

  it('keeps every typed value when stepping back and forward again', async () => {
    const user = userEvent.setup();
    renderPage();

    await passToken(user);
    await user.type(await screen.findByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/Display name/), 'Ada Lovelace');
    await user.click(continueButton());

    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByLabelText(/Username/)).toHaveValue('ada');
    expect(screen.getByLabelText(/Display name/)).toHaveValue('Ada Lovelace');

    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByLabelText(/Claim token/)).toHaveValue(CLAIM_TOKEN);
  });

  it('does not validate on the way back — a half-typed value is still your work', async () => {
    const user = userEvent.setup();
    renderPage();

    await passToken(user);
    await user.type(await screen.findByLabelText(/Email/), 'not-an-email');
    await user.click(await screen.findByRole('button', { name: 'Back' }));

    expect(await screen.findByText('Step 1 of 4')).toBeInTheDocument();
    expect(screen.queryByText(/doesn’t look like an email address/)).not.toBeInTheDocument();
  });

  it('redirects to sign-in when the server already has an owner', async () => {
    mockGetSetupStatus.mockResolvedValue({ data: { setup_required: false } });

    renderPage();

    expect(await screen.findByText('Welcome back')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Claim token/)).not.toBeInTheDocument();
  });

  it('reports an unreachable server instead of offering a claim that cannot work', async () => {
    mockGetSetupStatus.mockRejectedValue(new Error('Network Error'));

    renderPage();

    expect(await screen.findByText('Network Error')).toBeInTheDocument();
  });

  it.each([
    ['an uppercase letter', 'aa1!bcdefg', 'Password must include an uppercase letter (A–Z).'],
    ['a lowercase letter', 'AA1!BCDEFG', 'Password must include a lowercase letter (a–z).'],
    ['a digit', 'Aa!!bcdefg', 'Password must include a digit (0–9).'],
    ['a symbol or space', 'Aa1bcdefgh', 'Password must include a symbol or space.'],
  ])('will not pass the password step when it lacks %s', async (_missing, password, message) => {
    const user = userEvent.setup();
    renderPage();

    await passToken(user);
    await passOwner(user);
    await user.type(await screen.findByLabelText(/^Password/), password);
    await user.type(screen.getByLabelText(/Confirm password/), password);
    await user.click(continueButton());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    expect(mockClaimInstance).not.toHaveBeenCalled();
  });

  it('claims the server with exactly the payload the one-page form used to send', async () => {
    const user = userEvent.setup();
    mockClaimInstance.mockResolvedValue({
      data: {
        token: 'access-token',
        refresh_token: 'refresh-token',
        user: { id: '1', username: 'ada' },
        instance_name: 'Riverside Studio',
        space: { id: '99', name: 'The Lounge' },
      },
    });

    renderPage();
    await walkToLastStep(user);
    await user.click(claimButton());

    await waitFor(() => expect(mockClaimInstance).toHaveBeenCalledTimes(1));
    expect(mockClaimInstance).toHaveBeenCalledWith({
      token: CLAIM_TOKEN,
      username: 'ada',
      email: undefined,
      password: VALID_PASSWORD,
      instance_name: 'Riverside Studio',
      initial_space_name: 'The Lounge',
      display_name: undefined,
    });
    expect(mockSetAccessToken).toHaveBeenCalledWith('access-token');
    expect(mockSetRefreshToken).toHaveBeenCalledWith('refresh-token');
    expect(await screen.findByText('Server shell')).toBeInTheDocument();
  });

  it('sends an optional display name and email through unchanged', async () => {
    const user = userEvent.setup();
    mockClaimInstance.mockResolvedValue({
      data: {
        token: 'access-token',
        refresh_token: null,
        user: { id: '1', username: 'ada' },
        instance_name: 'Riverside Studio',
        space: { id: '99', name: 'The Lounge' },
      },
    });

    renderPage();
    await passToken(user);
    await user.type(await screen.findByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/Display name/), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/Email/), 'ada@example.test');
    await user.click(continueButton());
    await passPassword(user);
    await user.type(await screen.findByLabelText(/Instance name/), 'Riverside Studio');
    await user.type(screen.getByLabelText(/First server name/), 'The Lounge');
    await user.click(claimButton());

    await waitFor(() =>
      expect(mockClaimInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'ada@example.test',
          display_name: 'Ada Lovelace',
        }),
      ),
    );
  });

  it('brings a rejected claim into view rather than leaving it above the fold', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    // jsdom has no scrollIntoView; the page must both call it when present and
    // survive its absence (asserted by every other test here).
    Element.prototype.scrollIntoView = scrollIntoView;
    mockClaimInstance.mockRejectedValue(
      Object.assign(new Error('unauthorized'), {
        response: { status: 401, data: { message: 'unauthorized' } },
      }),
    );
    try {
      renderPage();
      await walkToLastStep(user);
      await user.click(claimButton());

      const banner = await screen.findByText(/not the one this instance printed/);
      expect(scrollIntoView).toHaveBeenCalled();
      // The live region holding the banner takes focus, so the rejection is
      // announced as well as scrolled to.
      expect(banner.closest('[aria-live="assertive"]')).toHaveFocus();
    } finally {
      // @ts-expect-error restoring the jsdom default (absent)
      delete Element.prototype.scrollIntoView;
    }
  });

  it('says a rejected token is the wrong token, not "unauthorized", and keeps the form usable', async () => {
    const user = userEvent.setup();
    // What the server actually answers: a bare 401 whose body message is the
    // wire string "unauthorized". Putting that on screen told the operator
    // nothing about the one thing that went wrong.
    mockClaimInstance.mockRejectedValue(
      Object.assign(new Error('unauthorized'), {
        response: { status: 401, data: { message: 'unauthorized' } },
      }),
    );

    renderPage();
    await walkToLastStep(user);
    await user.click(claimButton());

    expect(await screen.findByText(/not the one this instance printed/)).toBeInTheDocument();
    expect(screen.queryByText('unauthorized')).not.toBeInTheDocument();
    expect(claimButton()).toBeEnabled();
  });

  it('passes through the operator-authored message the server sends for other failures', async () => {
    const user = userEvent.setup();
    mockClaimInstance.mockRejectedValue(
      Object.assign(new Error('conflict: This instance has already been set up.'), {
        response: {
          status: 409,
          data: { message: 'conflict: This instance has already been set up.' },
        },
      }),
    );

    renderPage();
    await walkToLastStep(user);
    await user.click(claimButton());

    expect(await screen.findByText(/This instance has already been set up/)).toBeInTheDocument();
  });

  it('will not claim with a field cleared after its step was passed', async () => {
    const user = userEvent.setup();
    renderPage();

    await walkToLastStep(user);
    await user.clear(screen.getByLabelText(/Instance name/));
    await user.click(claimButton());

    expect(await screen.findByText(/Give this instance a name/)).toBeInTheDocument();
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument();
    expect(mockClaimInstance).not.toHaveBeenCalled();
  });
});

describe('claimStepError', () => {
  const draft = {
    token: CLAIM_TOKEN,
    username: 'ada',
    displayName: '',
    email: '',
    password: VALID_PASSWORD,
    confirmPassword: VALID_PASSWORD,
    instanceName: 'Riverside Studio',
    spaceName: 'The Lounge',
  };
  const options = { requireEmail: false };

  it('passes a complete draft at every step', () => {
    for (const step of ['token', 'owner', 'password', 'place'] as const) {
      expect(claimStepError(step, draft, options)).toBeNull();
    }
  });

  it('names the field a rejection belongs to', () => {
    expect(claimStepError('token', { ...draft, token: '  ' }, options)).toMatchObject({
      field: 'token',
    });
    expect(claimStepError('owner', { ...draft, username: '' }, options)).toMatchObject({
      field: 'username',
    });
    expect(claimStepError('owner', { ...draft, email: 'nope' }, options)).toMatchObject({
      field: 'email',
    });
    expect(
      claimStepError('password', { ...draft, confirmPassword: 'other' }, options),
    ).toMatchObject({ field: 'confirmPassword' });
    expect(claimStepError('place', { ...draft, spaceName: 'a' }, options)).toMatchObject({
      field: 'spaceName',
    });
  });

  it('requires an email only when the server does', () => {
    expect(claimStepError('owner', { ...draft, email: '' }, options)).toBeNull();
    expect(
      claimStepError('owner', { ...draft, email: '' }, { requireEmail: true }),
    ).toMatchObject({ field: 'email' });
  });
});

describe('passwordRulesMismatch', () => {
  it('says nothing before the server has answered', () => {
    expect(passwordRulesMismatch(null)).toBeNull();
  });

  it('says nothing when the page and the server agree', () => {
    expect(passwordRulesMismatch(SERVER_REQUIREMENTS)).toBeNull();
  });

  it('reports the server rules when they disagree, rather than letting them drift silently', () => {
    const message = passwordRulesMismatch({
      ...SERVER_REQUIREMENTS,
      min_length: 16,
      requires_symbol: false,
    });
    expect(message).toMatch(/16–128 bytes/);
    expect(message).toMatch(/symbol not required/);
  });
});
