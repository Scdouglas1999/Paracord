import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useServerListStore } from '../stores/serverListStore';
import { useAuthStore } from '../stores/authStore';
import { hasAccount } from '../lib/account';
import { getStoredServerUrl, getCurrentOriginServerUrl, setStoredServerUrl } from '../lib/apiBaseUrl';
import { gateway } from '../gateway/manager';

export function AccountUnlockPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const navigate = useNavigate();
  const unlock = useAccountStore((s) => s.unlock);
  const publicKey = useAccountStore((s) => s.publicKey);
  const username = useAccountStore((s) => s.username);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!hasAccount()) {
      navigate('/login');
    }
  }, [navigate]);

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
      await unlock(password);
      setFailedAttempts(0);
      setCooldownUntil(0);

      const serverUrl = getStoredServerUrl() || getCurrentOriginServerUrl();
      if (serverUrl) {
        setStoredServerUrl(serverUrl);
        const serverStore = useServerListStore.getState();
        const existingServer = serverStore.getServerByUrl(serverUrl);
        const tokenForServer = token || undefined;

        let serverName = serverUrl;
        try {
          serverName = new URL(serverUrl).host;
        } catch {
          // Keep raw URL as name if parsing fails.
        }

        const serverId = existingServer
          ? existingServer.id
          : serverStore.addServer(serverUrl, serverName, tokenForServer);

        const server = useServerListStore.getState().getServer(serverId);
        if (!server?.token) {
          try {
            await gateway.connectServer(serverId);
          } catch {
            // Non-fatal. User can still proceed and add/fix server details manually.
          }
        }
      }

      navigate('/app');
    } catch {
      const nextFailures = failedAttempts + 1;
      setFailedAttempts(nextFailures);
      if (nextFailures >= 3) {
        const backoffSeconds = Math.min(30, 2 ** Math.min(5, nextFailures - 3));
        setCooldownUntil(Date.now() + backoffSeconds * 1000);
      }
      setError('Unlock failed. Check your password and try again.');
    } finally {
      setLoading(false);
    }
  };

  const shortKey = publicKey ? `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}` : '';

  return (
    <div className="auth-shell">
      <form onSubmit={handleSubmit} className="auth-card mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold leading-tight text-text-primary">Welcome back</h1>
          <p className="mt-2 text-sm text-text-muted">
            Unlock your account to continue.
          </p>
        </div>

        {username && (
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-4 py-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-primary/20 text-accent-primary font-bold text-lg">
              {username[0].toUpperCase()}
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">{username}</p>
              <p className="text-xs font-mono text-text-muted">{shortKey}</p>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-5 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-3 text-sm font-medium text-accent-danger">
            {error}
          </div>
        )}

        <label className="mb-6 block">
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
            autoFocus
          />
        </label>

        <button
          type="submit"
          disabled={loading || Date.now() < cooldownUntil}
          className="btn-primary w-full"
        >
          {loading ? 'Unlocking...' : 'Unlock'}
        </button>

        <div className="mt-5 flex flex-col items-center gap-2 text-sm text-text-muted">
          <button
            type="button"
            onClick={() => navigate('/recover')}
            className="font-semibold text-text-link hover:underline"
          >
            Forgot password? Recover from phrase
          </button>
          <button
            type="button"
            onClick={() => navigate('/import')}
            className="font-semibold text-text-link hover:underline"
          >
            Import account from file
          </button>
        </div>
      </form>
    </div>
  );
}


