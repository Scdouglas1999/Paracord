import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useAccountStore } from '../stores/accountStore';
import { useServerListStore } from '../stores/serverListStore';
import { getStoredServerUrl, clearStoredServerUrl } from '../lib/apiBaseUrl';
import { hasAccount } from '../lib/account';
import { authApi } from '../api/auth';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const serverUrl = getStoredServerUrl();

  const handleChangeServer = () => {
    clearStoredServerUrl();
    window.location.href = '/connect';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);

      // Check if user already has a local keypair
      if (hasAccount()) {
        // Already has a client-side account — attach the pubkey to this server account
        const account = useAccountStore.getState();
        if (account.isUnlocked && account.publicKey) {
          try {
            await authApi.attachPublicKey(account.publicKey);
          } catch {
            // Non-fatal: pubkey may already be attached or server may not support it yet
          }
        }

        // Also add to server list if not already there
        if (serverUrl) {
          const existingServer = useServerListStore.getState().getServerByUrl(serverUrl);
          if (!existingServer) {
            const token = localStorage.getItem('token');
            useServerListStore.getState().addServer(serverUrl, new URL(serverUrl).host, token || undefined);
          }
        }

        navigate('/app');
      } else {
        // No local keypair — send to account setup in migration mode
        // This will create a keypair and attach it to their existing server account
        navigate('/setup?migrate=1');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <form onSubmit={handleSubmit} className="auth-card mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold leading-tight text-text-primary">Welcome back</h1>
          <p className="mt-2 text-sm text-text-muted">Sign in to continue to your servers.</p>
        </div>

        {error && (
          <div className="mb-5 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-3 text-sm font-medium text-accent-danger">
            {error}
          </div>
        )}

        <label className="mb-5 block">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Email <span className="text-accent-danger">*</span>
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="input-field mt-2"
            placeholder="you@example.com"
          />
        </label>

        <label className="mb-2 block">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
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

        <p className="mb-6 mt-2 text-xs leading-5 text-text-muted">
          Forgot your password? Contact your server administrator to reset your credentials.
        </p>

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? 'Logging in...' : 'Log In'}
        </button>

        <p className="mt-5 text-sm text-text-muted">
          Need an account?{' '}
          <Link to="/register" className="font-semibold text-text-link hover:underline">
            Register
          </Link>
        </p>

        {serverUrl && (
          <p className="mt-4 text-xs text-text-muted">
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
