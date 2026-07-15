import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useAccountStore } from '../stores/accountStore';
import { useServerListStore } from '../stores/serverListStore';
import {
  getStoredServerUrl,
  getCurrentOriginServerUrl,
  setStoredServerUrl,
  clearStoredServerUrl,
} from '../lib/config/apiBaseUrl';
import { hasAccount } from '../lib/account';
import { authApi } from '../api/auth';
import { getRefreshToken, setAccessToken, setRefreshToken } from '../lib/authToken';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import {
  AuthCanvas,
  AuthCard,
  AuthHeading,
  AppMark,
  BrandAside,
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

type LoginView = 'login' | 'forgot-password' | 'reset-password' | 'verify-email' | 'mfa-challenge';

export function LoginPage() {
  const [view, setView] = useState<LoginView>('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const serverUrl = getStoredServerUrl() || getCurrentOriginServerUrl();
  // Tracks the deferred view-switch timer so it can be cancelled on unmount,
  // preventing a setState on an unmounted component.
  const viewSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    let cancelled = false;
    authApi
      .options()
      .then(({ data }) => {
        if (cancelled) return;
        setAllowUsernameLogin(data.allow_username_login);
        setRequireEmail(data.require_email);
      })
      .catch(() => {
        // Keep conservative defaults when options are unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChangeServer = () => {
    clearStoredServerUrl();
    navigate('/connect');
  };

  const completeLoginFlow = async () => {
    // If the user already has a local keypair, attach it to this server account.
    if (hasAccount()) {
      const account = useAccountStore.getState();
      if (account.isUnlocked && account.publicKey) {
        try {
          const { data } = await authApi.attachPublicKey(account.publicKey);
          if (data.token && data.user) {
            setAccessToken(data.token);
            if (data.refresh_token) setRefreshToken(data.refresh_token);
            useAuthStore.setState({ token: data.token, user: data.user as import('../types').User });
          }
        } catch {
          // Non-fatal: pubkey may already be attached or server may not support it yet
        }
      }
    }

    // Add to server list if not already there
    if (serverUrl) {
      setStoredServerUrl(serverUrl);
      const serverStore = useServerListStore.getState();
      const existingServer = serverStore.getServerByUrl(serverUrl);
      const token = useAuthStore.getState().token;
      const refreshToken = getRefreshToken();
      if (!existingServer) {
        let serverName = serverUrl;
        try {
          serverName = new URL(serverUrl).host;
        } catch {
          // Keep raw URL as name if parsing fails.
        }
        const serverId = serverStore.addServer(serverUrl, serverName, token || undefined);
        serverStore.updateRefreshToken(serverId, refreshToken);
      } else if (token) {
        serverStore.updateToken(existingServer.id, token);
        serverStore.updateRefreshToken(existingServer.id, refreshToken);
      }
    }

    let pendingInvite: string | null = null;
    try {
      pendingInvite = sessionStorage.getItem('paracord:pending-invite');
      if (pendingInvite) sessionStorage.removeItem('paracord:pending-invite');
    } catch {
      /* ignore */
    }
    navigate(pendingInvite ? `/invite/${pendingInvite}` : '/app');
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
        if (data.refresh_token) setRefreshToken(data.refresh_token);
        useAuthStore.setState({ token: data.token, user: data.user as import('../types').User });
        await useAuthStore.getState().fetchUser();
      }
      setFailedAttempts(0);
      setCooldownUntil(0);
      await completeLoginFlow();
    } catch (err) {
      const serverMessage =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
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

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await authApi.mfaLogin(mfaTicket, mfaCode);
      const data = response.data;
      if (data.token && data.user) {
        setAccessToken(data.token);
        if (data.refresh_token) setRefreshToken(data.refresh_token);
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
        'If the account exists, a reset token has been generated. Check the server logs or contact your administrator to obtain the token, then enter it below.'
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
      onClick={() => { setError(''); setSuccessMsg(''); setMfaCode(''); setMfaTicket(''); setView('login'); }}
      className="text-label font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
    >
      Back to sign in
    </button>
  );

  // MFA challenge view
  if (view === 'mfa-challenge') {
    return (
      <AuthCanvas>
        <AuthCard className="max-w-md">
          <form onSubmit={handleMfaSubmit} className="flex flex-col gap-6 p-8">
            <AuthHeading
              title="Two-Factor Authentication"
              subtitle="Enter the 6-digit code from your authenticator app, or one of your backup codes."
            />

            {error && <ErrorBanner message={error} />}

            <Field label="Authentication Code" required>
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

            <Button type="submit" loading={loading} disabled={loading || !mfaCode.trim()} className="w-full">
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
        <AuthCard className="max-w-md">
          <form onSubmit={handleForgotPassword} className="flex flex-col gap-6 p-8">
            <AuthHeading
              title="Reset your password"
              subtitle="Enter your email or username and we’ll generate a reset token you can redeem below."
            />

            {error && <ErrorBanner message={error} />}
            {successMsg && <SuccessNote>{successMsg}</SuccessNote>}

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

            <Button type="submit" loading={loading} disabled={loading} className="w-full">
              Request Reset Token
            </Button>

            <div className="flex items-center justify-between text-label text-text-muted">
              <button
                type="button"
                onClick={() => { setError(''); setSuccessMsg(''); setView('reset-password'); }}
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
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
        <AuthCard className="max-w-md">
          <form onSubmit={handleResetPassword} className="flex flex-col gap-6 p-8">
            <AuthHeading
              title="Set New Password"
              subtitle="Paste the reset token from your administrator, then choose a new password."
            />

            {error && <ErrorBanner message={error} />}
            {successMsg && <SuccessNote>{successMsg}</SuccessNote>}

            <div className="flex flex-col gap-5">
              <Field label="Reset Token" required>
                <input
                  type="text"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  required
                  className="input-field font-code"
                  placeholder="Paste the token from your administrator"
                />
              </Field>

              <Field label="New Password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
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

              <Field label="Confirm Password" required>
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
            </div>

            <Button type="submit" loading={loading} disabled={loading} className="w-full">
              Set New Password
            </Button>

            <div className="flex items-center justify-between text-label text-text-muted">
              <button
                type="button"
                onClick={() => { setError(''); setSuccessMsg(''); setView('forgot-password'); }}
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
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
        <AuthCard className="max-w-md">
          <form onSubmit={handleVerifyEmail} className="flex flex-col gap-6 p-8">
            <AuthHeading
              title="Verify Email"
              subtitle="Enter the verification token your server administrator issued for your account."
            />

            {error && <ErrorBanner message={error} />}
            {successMsg && <SuccessNote>{successMsg}</SuccessNote>}

            <Field label="Verification Token" required>
              <input
                type="text"
                value={verifyEmailToken}
                onChange={(e) => setVerifyEmailToken(e.target.value)}
                required
                className="input-field font-code"
                placeholder="Paste verification token"
              />
            </Field>

            <Button type="submit" loading={loading} disabled={loading || !verifyEmailToken.trim()} className="w-full">
              Verify Email
            </Button>

            {backToLogin}
          </form>
        </AuthCard>
      </AuthCanvas>
    );
  }

  return (
    <AuthCanvas>
      <AuthCard className="max-w-4xl overflow-hidden">
        <div className="flex">
          <BrandAside />
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-6 p-8 sm:p-10">
            <div className="mb-1 lg:hidden">
              <AppMark size={40} />
            </div>
            <AuthHeading
              mark={false}
              title="Welcome back"
              subtitle="Sign in to pick up where you left off across your servers."
            />

            {error && <ErrorBanner message={error} />}

            <div className="flex flex-col gap-5">
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
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-muted">
              <button
                type="button"
                onClick={() => { setError(''); setView('forgot-password'); }}
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Forgot your password?
              </button>
              <span className="text-border-strong" aria-hidden="true">
                &middot;
              </span>
              <button
                type="button"
                onClick={() => { setError(''); setSuccessMsg(''); setView('verify-email'); }}
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Verify email token
              </button>
            </div>

            <Button
              type="submit"
              loading={loading}
              disabled={loading || Date.now() < cooldownUntil}
              className="w-full"
            >
              Log In
            </Button>

            <p className="text-label text-text-secondary">
              Need an account?{' '}
              <Link
                to="/register"
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Create one
              </Link>
            </p>

            {serverUrl && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border-subtle pt-5 text-meta text-text-muted">
                <span>Connected to</span>
                <span className="font-code text-text-secondary">{serverUrl}</span>
                <span className="text-border-strong" aria-hidden="true">
                  &middot;
                </span>
                <button
                  type="button"
                  onClick={handleChangeServer}
                  className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
                >
                  Change server
                </button>
              </div>
            )}
          </form>
        </div>
      </AuthCard>
    </AuthCanvas>
  );
}
