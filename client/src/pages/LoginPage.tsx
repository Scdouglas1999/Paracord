import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { setAccessToken, setRefreshToken } from '../lib/authToken';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';

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
  const serverUrl = getStoredServerUrl() || getCurrentOriginServerUrl();

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
      if (!existingServer) {
        let serverName = serverUrl;
        try {
          serverName = new URL(serverUrl).host;
        } catch {
          // Keep raw URL as name if parsing fails.
        }
        serverStore.addServer(serverUrl, serverName, token || undefined);
      } else if (token) {
        serverStore.updateToken(existingServer.id, token);
      }
    }

    navigate('/app');
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
      setTimeout(() => {
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
      setTimeout(() => {
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

  // MFA challenge view
  if (view === 'mfa-challenge') {
    return (
      <div className="auth-shell">
        <form
          onSubmit={handleMfaSubmit}
          className="auth-card mx-auto w-full max-w-md space-y-8 p-10"
        >
          <div className="text-center">
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Two-Factor Authentication</h1>
            <p className="mt-3 text-sm text-text-muted">
              Enter the 6-digit code from your authenticator app, or use a backup code.
            </p>
          </div>

          {error && <ErrorBanner message={error} />}

          <div className="card-stack-roomy">
            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Authentication Code <span className="text-accent-danger">*</span>
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                required
                className="input-field mt-2 text-center text-2xl tracking-widest"
                placeholder="000000"
                maxLength={20}
                autoFocus
              />
            </label>
          </div>

          <Button type="submit" disabled={loading || !mfaCode.trim()} className="mt-6 w-full">
            {loading ? 'Verifying...' : 'Verify'}
          </Button>

          <p className="mt-4 text-sm text-text-muted">
            <button
              type="button"
              onClick={() => { setError(''); setMfaCode(''); setMfaTicket(''); setView('login'); }}
              className="font-semibold text-text-link hover:underline"
            >
              Back to Login
            </button>
          </p>
        </form>
      </div>
    );
  }

  // Forgot password view
  if (view === 'forgot-password') {
    return (
      <div className="auth-shell">
        <form
          onSubmit={handleForgotPassword}
          className="auth-card mx-auto w-full max-w-md space-y-8 p-10"
        >
          <div className="text-center">
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Reset Password</h1>
            <p className="mt-3 text-sm text-text-muted">
              Enter your email or username to request a password reset token.
            </p>
          </div>

          {error && <ErrorBanner message={error} />}
          {successMsg && (
            <div className="rounded-xl border border-accent-success/35 bg-accent-success/10 px-5 py-4 text-sm font-medium text-accent-success">
              {successMsg}
            </div>
          )}

          <div className="card-stack-roomy">
            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Email or Username <span className="text-accent-danger">*</span>
              </span>
              <input
                type="text"
                value={resetIdentifier}
                onChange={(e) => setResetIdentifier(e.target.value)}
                required
                className="input-field mt-2"
                placeholder="you@example.com or username"
              />
            </label>
          </div>

          <Button type="submit" disabled={loading} className="mt-6 w-full">
            {loading ? 'Requesting...' : 'Request Reset Token'}
          </Button>

          <p className="mt-4 text-sm text-text-muted">
            Have a token?{' '}
            <button
              type="button"
              onClick={() => { setError(''); setSuccessMsg(''); setView('reset-password'); }}
              className="font-semibold text-text-link hover:underline"
            >
              Enter token
            </button>
          </p>
          <p className="mt-2 text-sm text-text-muted">
            <button
              type="button"
              onClick={() => { setError(''); setSuccessMsg(''); setView('login'); }}
              className="font-semibold text-text-link hover:underline"
            >
              Back to Login
            </button>
          </p>
        </form>
      </div>
    );
  }

  // Reset password (enter token + new password) view
  if (view === 'reset-password') {
    return (
      <div className="auth-shell">
        <form
          onSubmit={handleResetPassword}
          className="auth-card mx-auto w-full max-w-md space-y-8 p-10"
        >
          <div className="text-center">
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Set New Password</h1>
            <p className="mt-3 text-sm text-text-muted">
              Enter the reset token from your administrator and choose a new password.
            </p>
          </div>

          {error && <ErrorBanner message={error} />}
          {successMsg && (
            <div className="rounded-xl border border-accent-success/35 bg-accent-success/10 px-5 py-4 text-sm font-medium text-accent-success">
              {successMsg}
            </div>
          )}

          <div className="card-stack-roomy">
            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Reset Token <span className="text-accent-danger">*</span>
              </span>
              <input
                type="text"
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                required
                className="input-field mt-2"
                placeholder="Paste the token from your administrator"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                New Password <span className="text-accent-danger">*</span>
              </span>
              <input
                type="password"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
                required
                className="input-field mt-2"
                placeholder="At least 10 characters"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Confirm Password <span className="text-accent-danger">*</span>
              </span>
              <input
                type="password"
                value={resetConfirmPassword}
                onChange={(e) => setResetConfirmPassword(e.target.value)}
                required
                className="input-field mt-2"
                placeholder="Repeat your new password"
              />
            </label>
          </div>

          <Button type="submit" disabled={loading} className="mt-6 w-full">
            {loading ? 'Updating...' : 'Set New Password'}
          </Button>

          <p className="mt-4 text-sm text-text-muted">
            <button
              type="button"
              onClick={() => { setError(''); setSuccessMsg(''); setView('forgot-password'); }}
              className="font-semibold text-text-link hover:underline"
            >
              Request a new token
            </button>
            {' '}or{' '}
            <button
              type="button"
              onClick={() => { setError(''); setSuccessMsg(''); setView('login'); }}
              className="font-semibold text-text-link hover:underline"
            >
              Back to Login
            </button>
          </p>
        </form>
      </div>
    );
  }

  if (view === 'verify-email') {
    return (
      <div className="auth-shell">
        <form
          onSubmit={handleVerifyEmail}
          className="auth-card mx-auto w-full max-w-md space-y-8 p-10"
        >
          <div className="text-center">
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Verify Email</h1>
            <p className="mt-3 text-sm text-text-muted">
              Enter your email verification token from the server administrator.
            </p>
          </div>

          {error && <ErrorBanner message={error} />}
          {successMsg && (
            <div className="rounded-xl border border-accent-success/35 bg-accent-success/10 px-5 py-4 text-sm font-medium text-accent-success">
              {successMsg}
            </div>
          )}

          <div className="card-stack-roomy">
            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Verification Token <span className="text-accent-danger">*</span>
              </span>
              <input
                type="text"
                value={verifyEmailToken}
                onChange={(e) => setVerifyEmailToken(e.target.value)}
                required
                className="input-field mt-2"
                placeholder="Paste verification token"
              />
            </label>
          </div>

          <Button type="submit" disabled={loading || !verifyEmailToken.trim()} className="mt-6 w-full">
            {loading ? 'Verifying...' : 'Verify Email'}
          </Button>

          <p className="mt-4 text-sm text-text-muted">
            <button
              type="button"
              onClick={() => { setError(''); setSuccessMsg(''); setView('login'); }}
              className="font-semibold text-text-link hover:underline"
            >
              Back to Login
            </button>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <form onSubmit={handleSubmit} className="auth-card mx-auto w-full max-w-md space-y-8 p-10">
        <div className="text-center">
          <h1 className="text-3xl font-bold leading-tight text-text-primary">Welcome back</h1>
          <p className="mt-3 text-sm text-text-muted">Sign in to continue to your servers.</p>
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="card-stack-roomy">
          <label className="block">
            <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {identifierMode.label} <span className="text-accent-danger">*</span>
            </span>
            <input
              type={identifierMode.inputType}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              className="input-field mt-2"
              placeholder={identifierMode.placeholder}
            />
          </label>

          <label className="block">
            <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Password <span className="text-accent-danger">*</span>
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="input-field mt-2"
              placeholder="Enter your password"
            />
          </label>
        </div>

        <p className="text-xs leading-5 text-text-muted">
          <button
            type="button"
            onClick={() => { setError(''); setView('forgot-password'); }}
            className="font-semibold text-text-link hover:underline"
          >
            Forgot your password?
          </button>
          {' \u00b7 '}
          <button
            type="button"
            onClick={() => { setError(''); setSuccessMsg(''); setView('verify-email'); }}
            className="font-semibold text-text-link hover:underline"
          >
            Verify email token
          </button>
        </p>

        <Button
          type="submit"
          disabled={loading || Date.now() < cooldownUntil}
          className="mt-10 w-full"
        >
          {loading ? 'Logging in...' : 'Log In'}
        </Button>

        <p className="mt-8 text-sm text-text-muted">
          Need an account?{' '}
          <Link to="/register" className="font-semibold text-text-link hover:underline">
            Register
          </Link>
        </p>

        {serverUrl && (
          <p className="mt-8 text-xs text-text-muted">
            Connected to{' '}
            <span className="font-medium text-text-secondary">{serverUrl}</span>
            {' \u00b7 '}
            <button
              type="button"
              onClick={handleChangeServer}
              className="font-semibold text-text-link hover:underline"
            >
              Change Server
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
