import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceSetupPage, passwordRulesMismatch } from './InstanceSetupPage';

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
        <Route path="/app/guilds/:guildId" element={<div>Space shell</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillClaimForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Claim token/), CLAIM_TOKEN);
  await user.type(screen.getByLabelText(/Username/), 'ada');
  await user.type(screen.getByLabelText(/^Password/), VALID_PASSWORD);
  await user.type(screen.getByLabelText(/Confirm password/), VALID_PASSWORD);
  await user.type(screen.getByLabelText(/Server name/), 'Riverside Studio');
  await user.type(screen.getByLabelText(/First space name/), 'The Lounge');
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

    expect(await screen.findByText('Set up your Paracord server')).toBeInTheDocument();
    expect(
      screen.getByText(/You’re setting up the server itself, not joining one/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Everyone who arrives later signs up normally and joins as a member/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Joining someone else’s community instead\?/)).toBeInTheDocument();
  });

  it('explains where the claim token comes from before asking for it', async () => {
    renderPage();

    expect(await screen.findByText(/Prove you run this server/)).toBeInTheDocument();
    expect(screen.getByText(/first-owner-claim\.txt/)).toBeInTheDocument();
    expect(
      screen.getByText(/Nobody can create an account here until this token is used/),
    ).toBeInTheDocument();
  });

  it('shows the complete password requirements before typing', async () => {
    renderPage();

    const hint = await screen.findByText(/10–128 bytes/);
    expect(hint.textContent).toMatch(/uppercase letter \(A–Z\)/);
    expect(hint.textContent).toMatch(/lowercase letter \(a–z\)/);
    expect(hint.textContent).toMatch(/digit \(0–9\)/);
    expect(hint.textContent).toMatch(/ASCII symbol.*or space/);
    expect(screen.getByLabelText(/^Password/)).toHaveAccessibleDescription(hint.textContent!);
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
  ])('refuses to claim when the password lacks %s', async (_missing, password, message) => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText(/Claim token/);

    await user.type(screen.getByLabelText(/Claim token/), CLAIM_TOKEN);
    await user.type(screen.getByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/^Password/), password);
    await user.type(screen.getByLabelText(/Confirm password/), password);
    await user.type(screen.getByLabelText(/Server name/), 'Riverside Studio');
    await user.type(screen.getByLabelText(/First space name/), 'The Lounge');
    await user.click(screen.getByRole('button', { name: 'Claim this server' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mockClaimInstance).not.toHaveBeenCalled();
  });

  it('refuses to claim on a whitespace-only token, which the required attribute accepts', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText(/Claim token/);

    await user.type(screen.getByLabelText(/Claim token/), '   ');
    await user.type(screen.getByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/^Password/), VALID_PASSWORD);
    await user.type(screen.getByLabelText(/Confirm password/), VALID_PASSWORD);
    await user.type(screen.getByLabelText(/Server name/), 'Riverside Studio');
    await user.type(screen.getByLabelText(/First space name/), 'The Lounge');
    await user.click(screen.getByRole('button', { name: 'Claim this server' }));

    expect(
      await screen.findByText(/Paste the claim token from your server’s terminal/),
    ).toBeInTheDocument();
    expect(mockClaimInstance).not.toHaveBeenCalled();
  });

  it('brings a rejection into view rather than leaving it above the fold', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    // jsdom has no scrollIntoView; the page must both call it when present and
    // survive its absence (asserted by every other test here).
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderPage();
      await screen.findByLabelText(/Claim token/);

      await user.type(screen.getByLabelText(/Claim token/), CLAIM_TOKEN);
      await user.type(screen.getByLabelText(/Username/), 'ada');
      await user.type(screen.getByLabelText(/^Password/), 'nouppercase1!');
      await user.type(screen.getByLabelText(/Confirm password/), 'nouppercase1!');
      await user.type(screen.getByLabelText(/Server name/), 'Riverside Studio');
      await user.type(screen.getByLabelText(/First space name/), 'The Lounge');
      await user.click(screen.getByRole('button', { name: 'Claim this server' }));

      const banner = await screen.findByText(/Password must include/);
      expect(scrollIntoView).toHaveBeenCalled();
      // The live region holding the banner takes focus, so the rejection is
      // announced as well as scrolled to.
      expect(banner.closest('[aria-live="assertive"]')).toHaveFocus();
    } finally {
      // @ts-expect-error restoring the jsdom default (absent)
      delete Element.prototype.scrollIntoView;
    }
  });

  it('claims the server and lands the owner in the new space', async () => {
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
    await screen.findByLabelText(/Claim token/);
    await fillClaimForm(user);
    await user.click(screen.getByRole('button', { name: 'Claim this server' }));

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
    expect(await screen.findByText('Space shell')).toBeInTheDocument();
  });

  it('says a rejected token is the wrong token, not "unauthorized", and keeps the form usable', async () => {
    const user = userEvent.setup();
    // What the server actually answers: a bare 401 whose body message is the
    // wire string "unauthorized". Putting that on screen told the operator
    // nothing about the one thing that went wrong.
    const rejection = Object.assign(new Error('unauthorized'), {
      response: { status: 401, data: { message: 'unauthorized' } },
    });
    mockClaimInstance.mockRejectedValue(rejection);

    renderPage();
    await screen.findByLabelText(/Claim token/);
    await fillClaimForm(user);
    await user.click(screen.getByRole('button', { name: 'Claim this server' }));

    expect(
      await screen.findByText(/not the one this server printed/),
    ).toBeInTheDocument();
    expect(screen.queryByText('unauthorized')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim this server' })).toBeEnabled();
  });

  it('passes through the operator-authored message the server sends for other failures', async () => {
    const user = userEvent.setup();
    mockClaimInstance.mockRejectedValue(
      Object.assign(new Error('conflict: This server has already been set up.'), {
        response: { status: 409, data: { message: 'conflict: This server has already been set up.' } },
      }),
    );

    renderPage();
    await screen.findByLabelText(/Claim token/);
    await fillClaimForm(user);
    await user.click(screen.getByRole('button', { name: 'Claim this server' }));

    expect(
      await screen.findByText(/This server has already been set up/),
    ).toBeInTheDocument();
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
