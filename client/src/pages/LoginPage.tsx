import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuthStore } from '../stores/authStore';
import {
  getStoredServerUrl,
  getCurrentOriginServerUrl,
  clearStoredServerUrl,
} from '../lib/config/apiBaseUrl';
import { authApi } from '../api/auth';
import { instanceApi } from '../api/instance';
import { setAccessToken, setRefreshToken } from '../lib/authToken';
import { takeSessionEndedNotice } from '../lib/sessionEnded';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { ErrorBanner } from '../components/ui/Feedback';
import { useServerFeatureStore } from '../lib/serverFeatures';
import { LOCAL_SERVER_ID } from '../lib/serverScope';
import { findCredentialPin } from '../lib/credential/keystoreV2';
import { DOWNGRADE_MESSAGE } from '../lib/credential/errors';
import {
  completeLegacyMfa,
  completeMfaSignIn,
  confirmRecoverySaved,
  credentialErrorMessage,
  currentRecoveryPhrase,
  homeOrigin,
  legacySignIn,
  newPasswordProblem,
  signInWithPassword,
  START_OVER_WARNING,
  startOver,
  type CredentialMode,
  type PendingMfaSignIn,
  type SignInOutcome,
} from '../lib/oneCredential';
import { RecoveryPhraseCard } from './RecoveryPhraseCard';
import { useAccountStore } from '../stores/accountStore';

/** Hold the signed-in redirect while this page finishes a flow (see `AuthRoute`). */
const holdRedirect = (active: boolean) => useAccountStore.getState().setAccountFlowActive?.(active);
import { Button } from '../components/ui/Button';
import {
  AUTH_FORM,
  AuthCanvas,
  AuthCard,
  AuthHeading,
  AuthScroll,
  Field,
  SuccessNote,
} from './authScaffold';

type LoginIdentifierMode = {
  allowUsernameInput: boolean;
  label: string;
  inputType: 'text' | 'email';
  placeholder: string;
};

export function resolveLoginIdentifierMode(
  allowUsernameLogin: boolean,
  requireEmail: boolean,
): LoginIdentifierMode {
  // Optional-email mode requires username-compatible login input to avoid lockout.
  const allowUsernameInput = allowUsernameLogin || !requireEmail;
  return {
    allowUsernameInput,
    label: allowUsernameInput ? 'Email or Username' : 'Email',
    inputType: allowUsernameInput ? 'text' : 'email',
    placeholder: allowUsernameInput ? 'you@example.com or username' : 'you@example.com',
  };
}

/**
 * Where a completed sign-in should send the app, or `null` for "leave it alone".
 *
 * The session token is set several `await`s before this runs, and the route
 * guards act on it the moment it lands: `AuthRoute` leaves the sign-in screen,
 * and `ProtectedRoute` sends an account whose server has device crypto security
 * on to `/setup` or `/unlock`. Navigating to `/app` unconditionally arrives
 * *after* that and undoes it — the guard is then re-rendered on the path it
 * already rejected, with nothing new to react to, and the window renders
 * nothing at all. So only steer while this screen is still mounted — once a
 * guard has replaced it, it has already decided. An invite the person asked for
 * is the exception: that intent outranks the guard.
 */
export function destinationAfterLogin(
  pendingInvite: string | null,
  stillOnSignInScreen: boolean,
): string | null {
  // `joining=1`: they already pressed Join on that page before being sent here.
  if (pendingInvite) return `/invite/${pendingInvite}?joining=1`;
  if (!stillOnSignInScreen) return null;
  return '/app';
}

/** Whether this device has pinned `identifier` on this server as a one-password account (§3.13). */
function knownOnePasswordAccount(identifier: string): boolean {
  try {
    return findCredentialPin(homeOrigin(), { identifier }) !== null;
  } catch {
    return false;
  }
}

type LoginView =
  | 'login'
  | 'forgot-password'
  | 'reset-password'
  | 'verify-email'
  | 'mfa-challenge'
  /** §3.11: a v1 account, asked for its old sign-in password on a screen that says so. */
  | 'legacy-account'
  /** §1.8 again: the account's recovery phrase was never confirmed. */
  | 'phrase';

export function LoginPage() {
  const [view, setView] = useState<LoginView>('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // Why the user is here without asking to be. Read once, at mount, so the
  // sentence survives the redirect that brought them and is not repeated on
  // every later visit to this screen.
  const [sessionNotice] = useState<string | null>(() => takeSessionEndedNotice());
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [allowUsernameLogin, setAllowUsernameLogin] = useState(true);
  const [requireEmail, setRequireEmail] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  // Forgot/reset password state
  const [resetIdentifier, setResetIdentifier] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [verifyEmailToken, setVerifyEmailToken] = useState('');
  // MFA challenge state
  const [mfaTicket, setMfaTicket] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  // One password (docs/setup-spec.md §3): which sign-in this server runs, read
  // from `/auth/options` before anyone types, never guessed from a failure.
  const [credentialMode, setCredentialMode] = useState<CredentialMode | 'unreachable' | null>(null);
  const [pendingMfa, setPendingMfa] = useState<PendingMfaSignIn | null>(null);
  const [legacyMfa, setLegacyMfa] = useState(false);
  const [legacyPassword, setLegacyPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [resetIdentifierForStartOver, setResetIdentifierForStartOver] = useState('');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const serverUrl = getStoredServerUrl() || getCurrentOriginServerUrl();
  // Tracks the deferred view-switch timer so it can be canceled on unmount,
  // preventing a setState on an unmounted component.
  const viewSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether this screen is still the one on show. `completeLoginFlow` runs
  // after awaits, by which time a route guard may already have replaced it.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      holdRedirect(false);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (viewSwitchTimer.current !== null) {
        clearTimeout(viewSwitchTimer.current);
        viewSwitchTimer.current = null;
      }
    };
  }, []);

  // Deep links from password-reset / email-verify emails.
  useEffect(() => {
    const resetToken = searchParams.get('reset_token');
    const verifyToken = searchParams.get('verify_token') || searchParams.get('token');
    if (resetToken) {
      setResetToken(resetToken);
      setView('reset-password');
      setSearchParams({}, { replace: true });
      return;
    }
    if (verifyToken && searchParams.has('verify_token')) {
      setVerifyEmailToken(verifyToken);
      setView('verify-email');
      setSearchParams({}, { replace: true });
      return;
    }
    // Bare ?token= on /login is treated as email verification when no reset_token.
    if (verifyToken && !resetToken && searchParams.get('token')) {
      setVerifyEmailToken(verifyToken);
      setView('verify-email');
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    let canceled = false;
    authApi
      .options()
      .then(({ data }) => {
        if (canceled) return;
        setAllowUsernameLogin(data.allow_username_login);
        setRequireEmail(data.require_email);
        const oneCredential = data.credential_version === 2;
        if (oneCredential) useServerFeatureStore.getState().forget(LOCAL_SERVER_ID);
        else useServerFeatureStore.getState().markMissing(LOCAL_SERVER_ID, 'oneCredential');
        setCredentialMode(oneCredential ? 'one-password' : 'legacy');
      })
      .catch(() => {
        // Keep conservative defaults when options are unavailable; the
        // sign-in mode stays unknown and submitting says the server is away.
        if (!canceled) setCredentialMode('unreachable');
      });
    return () => {
      canceled = true;
    };
  }, []);

  // A server nobody has claimed yet has no accounts at all, so "Welcome back"
  // is a dead end: send the operator to the claim flow instead.
  useEffect(() => {
    let canceled = false;
    instanceApi
      .getSetupStatus()
      .then(({ data }) => {
        if (!canceled && data.setup_required) navigate('/setup-server', { replace: true });
      })
      .catch(() => {
        // An unreachable server is reported by the sign-in attempt itself;
        // never assume setup state from a failed request.
      });
    return () => {
      canceled = true;
    };
  }, [navigate]);

  const handleChangeServer = () => {
    clearStoredServerUrl();
    navigate('/connect');
  };

  const completeLoginFlow = async () => {
    let pendingInvite: string | null = null;
    try {
      pendingInvite = sessionStorage.getItem('paracord:pending-invite');
      if (pendingInvite) sessionStorage.removeItem('paracord:pending-invite');
    } catch {
      /* ignore */
    }
    const destination = destinationAfterLogin(pendingInvite, mountedRef.current);
    if (destination) navigate(destination, { replace: true });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const now = Date.now();
    if (now < cooldownUntil) {
      const waitSeconds = Math.ceil((cooldownUntil - now) / 1000);
      setError(`Too many attempts. Try again in ${waitSeconds}s.`);
      return;
    }
    if (credentialMode === 'one-password') {
      await submitOnePassword();
      return;
    }
    if (credentialMode === 'unreachable') {
      setError(`Could not reach ${serverUrl ?? 'the instance'}. It may be restarting, or this machine cannot see it.`);
      return;
    }
    // An account this device knows uses one password never sends its password
    // to the old route, whatever this server now claims (§3.13).
    if (knownOnePasswordAccount(identifier)) {
      setError(DOWNGRADE_MESSAGE);
      return;
    }
    setLoading(true);
    try {
      // Direct API call to check for MFA requirement
      const response = await authApi.login({ email: identifier, password });
      const data = response.data;

      // Check if MFA is required
      if (data.user && (data.user as unknown as Record<string, unknown>).mfa_required) {
        const ticket = (data.user as unknown as Record<string, unknown>).mfa_ticket as string;
        setMfaTicket(ticket);
        setMfaCode('');
        setView('mfa-challenge');
        setLoading(false);
        return;
      }

      // Normal login — set auth state
      if (data.token && data.user) {
        setAccessToken(data.token);
        setRefreshToken(data.refresh_token ?? null);
        useAuthStore.setState({ token: data.token, user: data.user as import('../types').User });
        await useAuthStore.getState().fetchUser();
      }
      setFailedAttempts(0);
      setCooldownUntil(0);
      await completeLoginFlow();
    } catch (err) {
      const response = (err as { response?: { data?: { message?: string } } })?.response;
      // No response at all means the server never answered — it is down, or
      // this machine cannot reach it. Telling someone to check the password
      // they typed correctly is a lie, and counting it toward the lockout
      // backoff then silently swallows their next few attempts: during a
      // restart the button simply stops doing anything, with the wrong
      // sentence still on screen.
      if (!response) {
        setError(
          `Could not reach ${serverUrl ?? 'the instance'}. It may be restarting, or this machine cannot see it. Your password was not the problem.`,
        );
        return;
      }
      const serverMessage = response.data?.message;
      const nextFailures = failedAttempts + 1;
      setFailedAttempts(nextFailures);
      if (nextFailures >= 3) {
        const backoffSeconds = Math.min(30, 2 ** Math.min(5, nextFailures - 3));
        setCooldownUntil(Date.now() + backoffSeconds * 1000);
      }
      setError(
        serverMessage && serverMessage !== 'unauthorized'
          ? serverMessage
          : 'Login failed. Check your credentials and try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  const noteFailure = () => {
    const nextFailures = failedAttempts + 1;
    setFailedAttempts(nextFailures);
    if (nextFailures >= 3) {
      const backoffSeconds = Math.min(30, 2 ** Math.min(5, nextFailures - 3));
      setCooldownUntil(Date.now() + backoffSeconds * 1000);
    }
  };

  /** What a one-password sign-in (or MFA step) led to. */
  const settleOutcome = async (outcome: SignInOutcome) => {
    setPassword('');
    if (outcome.kind === 'legacy') {
      setError('');
      setLegacyPassword('');
      setView('legacy-account');
      return;
    }
    if (outcome.kind === 'mfa') {
      setPendingMfa(outcome.pending);
      setMfaCode('');
      setView('mfa-challenge');
      return;
    }
    setFailedAttempts(0);
    setCooldownUntil(0);
    setPendingMfa(null);
    if (!outcome.recoveryConfirmed) {
      const words = currentRecoveryPhrase();
      if (words) {
        setPhrase(words);
        setView('phrase');
        return;
      }
    }
    holdRedirect(false);
    await completeLoginFlow();
  };

  const submitOnePassword = async () => {
    setLoading(true);
    holdRedirect(true);
    try {
      await settleOutcome(await signInWithPassword(identifier, password));
    } catch (err) {
      holdRedirect(false);
      const hasResponse = Boolean((err as { response?: unknown } | null)?.response);
      if (hasResponse) noteFailure();
      setError(credentialErrorMessage(err, 'That username or password is wrong.'));
    } finally {
      setLoading(false);
    }
  };

  const handleLegacyAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const outcome = await legacySignIn(identifier, legacyPassword);
      setLegacyPassword('');
      if (outcome.kind === 'mfa') {
        setMfaTicket(outcome.ticket);
        setLegacyMfa(true);
        setMfaCode('');
        setView('mfa-challenge');
        return;
      }
      navigate('/setup', { replace: true });
    } catch (err) {
      setError(credentialErrorMessage(err, "That isn't your current sign-in password."));
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (pendingMfa) {
      setLoading(true);
      holdRedirect(true);
      try {
        await settleOutcome(await completeMfaSignIn(pendingMfa, mfaCode));
      } catch (err) {
        holdRedirect(false);
        setError(credentialErrorMessage(err, 'Invalid MFA code. Please try again.'));
      } finally {
        setLoading(false);
      }
      return;
    }
    if (legacyMfa) {
      setLoading(true);
      try {
        await completeLegacyMfa(mfaTicket, mfaCode);
        setLegacyMfa(false);
        navigate('/setup', { replace: true });
      } catch {
        setError('Invalid MFA code. Please try again.');
      } finally {
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    try {
      const response = await authApi.mfaLogin(mfaTicket, mfaCode);
      const data = response.data;
      if (data.token && data.user) {
        setAccessToken(data.token);
        setRefreshToken(data.refresh_token ?? null);
        useAuthStore.setState({ token: data.token, user: data.user as import('../types').User });
        await useAuthStore.getState().fetchUser();
      }
      setFailedAttempts(0);
      setCooldownUntil(0);
      await completeLoginFlow();
    } catch {
      setError('Invalid MFA code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    setLoading(true);
    try {
      await authApi.forgotPassword(resetIdentifier);
      setSuccessMsg(
        'If the account exists, a reset token has been generated. Check the instance logs or contact your administrator to obtain the token, then enter it below.'
      );
      setView('reset-password');
    } catch {
      setError('Failed to request password reset. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    if (resetNewPassword !== resetConfirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (credentialMode === 'one-password') {
      await submitStartOver();
      return;
    }
    setLoading(true);
    try {
      await authApi.resetPassword(resetToken, resetNewPassword);
      setSuccessMsg('Password updated successfully. You can now log in with your new password.');
      setResetToken('');
      setResetNewPassword('');
      setResetConfirmPassword('');
      if (viewSwitchTimer.current !== null) clearTimeout(viewSwitchTimer.current);
      viewSwitchTimer.current = setTimeout(() => {
        viewSwitchTimer.current = null;
        setView('login');
        setSuccessMsg('');
      }, 3000);
    } catch {
      setError('Failed to reset password. The token may be invalid or expired.');
    } finally {
      setLoading(false);
    }
  };

  /** "Start over" (§3.9): the reset token with a brand-new identity. */
  const submitStartOver = async () => {
    const identifierForReset = resetIdentifierForStartOver.trim() || resetIdentifier.trim();
    if (!identifierForReset) {
      setError('Enter the username or email of the account you are resetting.');
      return;
    }
    const problem = await newPasswordProblem(resetNewPassword, { username: identifierForReset });
    if (problem) {
      setError(problem);
      return;
    }
    setLoading(true);
    holdRedirect(true);
    try {
      const outcome = await startOver({ token: resetToken, identifier: identifierForReset, newPassword: resetNewPassword });
      setResetToken('');
      setResetNewPassword('');
      setResetConfirmPassword('');
      if (outcome.kind === 'legacy-reset') {
        holdRedirect(false);
        setSuccessMsg('Password updated successfully. You can now log in with your new password.');
        setView('login');
        return;
      }
      setIdentifier(identifierForReset);
      await settleOutcome(outcome);
    } catch (err) {
      holdRedirect(false);
      setError(credentialErrorMessage(err, 'Failed to reset password. The token may be invalid or expired.'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    setLoading(true);
    try {
      await authApi.verifyEmail(verifyEmailToken);
      setSuccessMsg('Email verified successfully. You can now log in.');
      setVerifyEmailToken('');
      if (viewSwitchTimer.current !== null) clearTimeout(viewSwitchTimer.current);
      viewSwitchTimer.current = setTimeout(() => {
        viewSwitchTimer.current = null;
        setView('login');
        setSuccessMsg('');
      }, 2500);
    } catch {
      setError('Failed to verify email. The token may be invalid or expired.');
    } finally {
      setLoading(false);
    }
  };

  const identifierMode = resolveLoginIdentifierMode(allowUsernameLogin, requireEmail);

  const backToLogin = (
    <button
      type="button"
      onClick={() => { setError(''); setSuccessMsg(''); setMfaCode(''); setMfaTicket(''); setPendingMfa(null); setLegacyMfa(false); setView('login'); }}
      className="ix-auth__link"
    >
      Back to sign in
    </button>
  );

  if (view === 'phrase' && phrase) {
    return (
      <RecoveryPhraseCard
        phrase={phrase}
        onConfirm={async () => {
          await confirmRecoverySaved();
          setPhrase('');
          holdRedirect(false);
          await completeLoginFlow();
        }}
      />
    );
  }

  // §3.11: deliberately not the normal form. It names the OLD password, so a
  // person never types their one password here by habit.
  if (view === 'legacy-account') {
    return (
      <AuthCanvas>
        <AuthCard>
          <form onSubmit={handleLegacyAccountSubmit} className={AUTH_FORM}>
            <AuthHeading
              title="This account still uses two passwords"
              subtitle="Enter your current sign-in password. Next, Paracord moves the account to one password."
            />

            {error && <ErrorBanner multiline message={error} />}

            <AuthScroll>
              <p className="text-[14px] text-[var(--ix-ink-2)]">
                Signing in as <span className="font-semibold text-[var(--ix-ink)]">{identifier}</span>
              </p>
              <Field label="Current sign-in password" required>
                <input
                  type="password"
                  value={legacyPassword}
                  onChange={(e) => setLegacyPassword(e.target.value)}
                  required
                  className="input-field"
                  placeholder="The password you signed in with before"
                  autoComplete="current-password"
                  autoFocus
                />
              </Field>
            </AuthScroll>

            <Button size="lg" type="submit" loading={loading} disabled={loading || !legacyPassword} className="w-full">
              Continue
            </Button>

            {backToLogin}
          </form>
        </AuthCard>
      </AuthCanvas>
    );
  }

  // MFA challenge view
  if (view === 'mfa-challenge') {
    return (
      <AuthCanvas>
        <AuthCard>
          <form onSubmit={handleMfaSubmit} className={AUTH_FORM}>
            <AuthHeading
              title="Two-factor authentication"
              subtitle="Enter the 6-digit code from your authenticator app, or one of your backup codes."
            />

            {error && <ErrorBanner multiline message={error} />}

            <AuthScroll>
              <Field label="Authentication code" required>
                <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                required
                className="input-field text-center font-code text-2xl tracking-[0.4em]"
                  placeholder="000000"
                  maxLength={20}
                  autoFocus
                />
              </Field>
            </AuthScroll>

            <Button size="lg" type="submit" loading={loading} disabled={loading || !mfaCode.trim()} className="w-full">
              Verify
            </Button>

            {backToLogin}
          </form>
        </AuthCard>
      </AuthCanvas>
    );
  }

  // Forgot password view
  if (view === 'forgot-password') {
    return (
      <AuthCanvas>
        <AuthCard>
          <form onSubmit={handleForgotPassword} className={AUTH_FORM}>
            <AuthHeading
              title="Reset your password"
              subtitle="Enter your email or username and we’ll generate a reset token you can redeem below."
            />

            {error && <ErrorBanner multiline message={error} />}
            {successMsg && <SuccessNote>{successMsg}</SuccessNote>}

            <AuthScroll>
              <Field label="Email or Username" required>
                <input
                  type="text"
                  value={resetIdentifier}
                  onChange={(e) => setResetIdentifier(e.target.value)}
                  required
                  className="input-field"
                  placeholder="you@example.com or username"
                />
              </Field>
            </AuthScroll>

            <Button size="lg" type="submit" loading={loading} disabled={loading} className="w-full">
              Request reset token
            </Button>

            <div className="flex items-center justify-between text-[13.5px] text-[var(--ix-ink-3)]">
              <button
                type="button"
                onClick={() => { setError(''); setSuccessMsg(''); setView('reset-password'); }}
                className="ix-auth__link"
              >
                Enter token
              </button>
              {backToLogin}
            </div>
          </form>
        </AuthCard>
      </AuthCanvas>
    );
  }

  // Reset password (enter token + new password) view
  if (view === 'reset-password') {
    return (
      <AuthCanvas>
        <AuthCard>
          <form onSubmit={handleResetPassword} className={AUTH_FORM}>
            <AuthHeading
              title={credentialMode === 'one-password' ? 'Start over' : 'Set new password'}
              subtitle="Paste the reset token from your administrator, then choose a new password."
            />

            {error && <ErrorBanner multiline message={error} />}
            {successMsg && <SuccessNote>{successMsg}</SuccessNote>}
            {credentialMode === 'one-password' && (
              <div role="note" className="pc-well flex items-start gap-2.5 px-4 py-3 text-[14px] text-[var(--ix-ink-2)]">
                <Info size={16} className="mt-px shrink-0 text-[var(--ix-ink-3)]" />
                <span className="leading-relaxed">
                  {START_OVER_WARNING}{' '}
                  <button type="button" onClick={() => navigate('/recover')} className="ix-auth__link">
                    Use your recovery phrase
                  </button>
                </span>
              </div>
            )}

            <AuthScroll>
              {credentialMode === 'one-password' && (
                <Field label="Username or email" required>
                  <input
                    type="text"
                    value={resetIdentifierForStartOver || resetIdentifier}
                    onChange={(e) => setResetIdentifierForStartOver(e.target.value)}
                    required
                    className="input-field"
                    placeholder="you@example.com or username"
                    autoComplete="username"
                  />
                </Field>
              )}
              <Field label="Reset token" required>
                <input
                  type="text"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  required
                  className="input-field font-code"
                  placeholder="Paste the token from your administrator"
                />
              </Field>

              <Field label="New password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
                <input
                  type="password"
                  value={resetNewPassword}
                  onChange={(e) => setResetNewPassword(e.target.value)}
                  required
                  className="input-field"
                  placeholder="Choose a strong password"
                  autoComplete="new-password"
                />
              </Field>

              <Field label="Confirm password" required>
                <input
                  type="password"
                  value={resetConfirmPassword}
                  onChange={(e) => setResetConfirmPassword(e.target.value)}
                  required
                  className="input-field"
                  placeholder="Repeat your new password"
                  autoComplete="new-password"
                />
              </Field>
            </AuthScroll>

            <Button size="lg" type="submit" loading={loading} disabled={loading} className="w-full">
              Set new password
            </Button>

            <div className="flex items-center justify-between text-[13.5px] text-[var(--ix-ink-3)]">
              <button
                type="button"
                onClick={() => { setError(''); setSuccessMsg(''); setView('forgot-password'); }}
                className="ix-auth__link"
              >
                Request a new token
              </button>
              {backToLogin}
            </div>
          </form>
        </AuthCard>
      </AuthCanvas>
    );
  }

  if (view === 'verify-email') {
    return (
      <AuthCanvas>
        <AuthCard>
          <form onSubmit={handleVerifyEmail} className={AUTH_FORM}>
            <AuthHeading
              title="Verify email"
              subtitle="Enter the verification token your instance administrator issued for your account."
            />

            {error && <ErrorBanner multiline message={error} />}
            {successMsg && <SuccessNote>{successMsg}</SuccessNote>}

            <AuthScroll>
              <Field label="Verification token" required>
                <input
                  type="text"
                  value={verifyEmailToken}
                  onChange={(e) => setVerifyEmailToken(e.target.value)}
                  required
                  className="input-field font-code"
                  placeholder="Paste verification token"
                />
              </Field>
            </AuthScroll>

            <Button size="lg" type="submit" loading={loading} disabled={loading || !verifyEmailToken.trim()} className="w-full">
              Verify email
            </Button>

            {backToLogin}
          </form>
        </AuthCard>
      </AuthCanvas>
    );
  }

  return (
    <AuthCanvas>
      <AuthCard>
        <div>
          <form onSubmit={handleSubmit} className={AUTH_FORM}>
            <AuthHeading
              title="Welcome back"
              subtitle="Sign in to pick up where you left off across your servers."
            />

            {sessionNotice && !error && (
              <div
                role="status"
                className="pc-well flex items-start gap-2.5 px-4 py-3 text-[14px] text-[var(--ix-ink-2)]"
              >
                <Info size={16} className="mt-px shrink-0 text-[var(--ix-ink-3)]" />
                <span className="leading-relaxed">{sessionNotice}</span>
              </div>
            )}

            {error && <ErrorBanner multiline message={error} />}

            <AuthScroll>
              <Field label={identifierMode.label} required>
                <input
                  type={identifierMode.inputType}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                  className="input-field"
                  placeholder={identifierMode.placeholder}
                  autoComplete="username"
                />
              </Field>

              <Field label="Password" required>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="input-field"
                  placeholder="Enter your password"
                  autoComplete="current-password"
                />
              </Field>
            </AuthScroll>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-[var(--ix-ink-3)]">
              {credentialMode === 'one-password' ? (
                <span>
                  Forgot your password?{' '}
                  <button type="button" onClick={() => navigate('/recover')} className="ix-auth__link">
                    Use your recovery phrase
                  </button>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => { setError(''); setView('forgot-password'); }}
                    className="ix-auth__link"
                  >
                    reset by email
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => { setError(''); setView('forgot-password'); }}
                  className="ix-auth__link"
                >
                  Forgot your password?
                </button>
              )}
              <span className="text-[var(--ix-ink-3)]" aria-hidden="true">
                &middot;
              </span>
              <button
                type="button"
                onClick={() => { setError(''); setSuccessMsg(''); setView('verify-email'); }}
                className="ix-auth__link"
              >
                Verify email token
              </button>
            </div>

            {/* The 24 words the app insists you write down are useless if the
                only screens that accept them sit behind a password. A new
                install reaches exactly this screen and nothing else. Its own
                row: it is a different kind of way in from the two above, and a
                wrapped middot reads as a typo. */}
            {credentialMode !== 'one-password' && (
              <div className="text-[13.5px] text-[var(--ix-ink-3)]">
                <button
                  type="button"
                  onClick={() => navigate('/recover')}
                  className="ix-auth__link"
                >
                  Recover from phrase
                </button>
              </div>
            )}

            <Button size="lg"
              type="submit"
              loading={loading}
              disabled={loading || Date.now() < cooldownUntil}
              className="w-full"
            >
              Log in
            </Button>

            <p className="text-[13.5px] text-[var(--ix-ink-2)]">
              Need an account?{' '}
              <Link
                to="/register"
                className="font-semibold text-text-link underline-offset-4 hover:underline"
              >
                Create one
              </Link>
            </p>

            {serverUrl && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--ix-line)] pt-5 text-[13px] text-[var(--ix-ink-3)]">
                <span>Connected to</span>
                <span className="font-code text-[var(--ix-ink-2)]">{serverUrl}</span>
                <span className="text-[var(--ix-ink-3)]" aria-hidden="true">
                  &middot;
                </span>
                <button
                  type="button"
                  onClick={handleChangeServer}
                  className="ix-auth__link"
                >
                  Change instance
                </button>
              </div>
            )}
          </form>
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
