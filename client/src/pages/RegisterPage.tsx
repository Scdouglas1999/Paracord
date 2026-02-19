import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useAccountStore } from '../stores/accountStore';
import { useServerListStore } from '../stores/serverListStore';
import { getStoredServerUrl, getCurrentOriginServerUrl, setStoredServerUrl } from '../lib/apiBaseUrl';
import { hasAccount } from '../lib/account';
import { authApi } from '../api/auth';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';

export function RegisterPage() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [requireEmail, setRequireEmail] = useState(false);
  const navigate = useNavigate();
  const register = useAuthStore((s) => s.register);

  useEffect(() => {
    let cancelled = false;
    authApi
      .options()
      .then(({ data }) => {
        if (cancelled) return;
        setRequireEmail(data.require_email);
      })
      .catch(() => {
        // Keep conservative defaults when options are unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!agreed) {
      setError('You must agree to the terms of service');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await register(email, username, password, displayName);

      // If the user already has a local keypair, attach it to this server account.
      if (hasAccount()) {
        const account = useAccountStore.getState();
        if (account.isUnlocked && account.publicKey) {
          try {
            await authApi.attachPublicKey(account.publicKey);
          } catch {
            // Non-fatal
          }
        }
      }

      // Add to server list if not already there
      const serverUrl = getStoredServerUrl() || getCurrentOriginServerUrl();
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
    } catch (err: any) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="flex w-full justify-center">
        <form onSubmit={handleSubmit} className="auth-card space-y-8 p-10">
          <div className="text-center">
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Create an account</h1>
            <p className="mt-3 text-sm text-text-muted">Pick your username and start hanging out.</p>
          </div>

          {error && (
            <div className="rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-5 py-4 text-sm font-medium text-accent-danger">
              {error}
            </div>
          )}

          <div className="card-stack-roomy">
            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Email {requireEmail && <span className="text-accent-danger">*</span>}
              </span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required={requireEmail}
                className="input-field mt-2"
                placeholder={requireEmail ? 'you@example.com' : 'Optional'}
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">Display Name</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input-field mt-2"
                placeholder="How people see you"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Username <span className="text-accent-danger">*</span>
              </span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                className="input-field mt-2"
                placeholder="Unique account handle"
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
                minLength={MIN_PASSWORD_LENGTH}
                className="input-field mt-2"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              />
            </label>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-4">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-1 accent-[var(--accent-primary)]"
            />
            <span className="text-xs leading-5 text-text-muted">
              I have read and agree to the{' '}
              <Link to="/terms" className="font-semibold text-text-link hover:underline">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link to="/privacy" className="font-semibold text-text-link hover:underline">
                Privacy Policy
              </Link>
              .
            </span>
          </label>

          <button type="submit" disabled={loading} className="btn-primary mt-10 w-full min-h-[2.9rem]">
            {loading ? 'Creating account...' : 'Continue'}
          </button>

          <p className="mt-8 text-center text-sm text-text-muted">
            <Link to="/login" className="font-semibold text-text-link hover:underline">
              Already have an account?
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
