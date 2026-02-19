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
} from '../lib/apiBaseUrl';
import { hasAccount } from '../lib/account';
import { authApi } from '../api/auth';

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

export function LoginPage() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [allowUsernameLogin, setAllowUsernameLogin] = useState(true);
  const [requireEmail, setRequireEmail] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
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
    window.location.href = '/connect';
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
      await login(identifier, password);
      setFailedAttempts(0);
      setCooldownUntil(0);

      // If the user already has a local keypair, attach it to this server account.
      if (hasAccount()) {
        const account = useAccountStore.getState();
        if (account.isUnlocked && account.publicKey) {
          try {
            await authApi.attachPublicKey(account.publicKey);
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

      // Go straight to the app — legacy token auth works without a local
      // keypair. Users can set up a local crypto identity later in Settings.
      navigate('/app');
    } catch {
      const nextFailures = failedAttempts + 1;
      setFailedAttempts(nextFailures);
      if (nextFailures >= 3) {
        const backoffSeconds = Math.min(30, 2 ** Math.min(5, nextFailures - 3));
        setCooldownUntil(Date.now() + backoffSeconds * 1000);
      }
      setError('Login failed. Check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  };

  const identifierMode = resolveLoginIdentifierMode(allowUsernameLogin, requireEmail);

  return (
    <div className="auth-shell">
      <form onSubmit={handleSubmit} className="auth-card mx-auto w-full max-w-md space-y-8 p-10">
        <div className="text-center">
          <h1 className="text-3xl font-bold leading-tight text-text-primary">Welcome back</h1>
          <p className="mt-3 text-sm text-text-muted">Sign in to continue to your servers.</p>
        </div>

        {error && (
          <div className="rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-5 py-4 text-sm font-medium text-accent-danger">
            {error}
          </div>
        )}

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
          Forgot your password? Contact your server administrator to reset your credentials.
        </p>

        <button
          type="submit"
          disabled={loading || Date.now() < cooldownUntil}
          className="btn-primary mt-10 w-full"
        >
          {loading ? 'Logging in...' : 'Log In'}
        </button>

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
