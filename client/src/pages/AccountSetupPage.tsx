import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { getStoredServerUrl, getCurrentOriginServerUrl, setStoredServerUrl } from '../lib/apiBaseUrl';
import { authApi } from '../api/auth';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';

export function AccountSetupPage() {
  const [searchParams] = useSearchParams();
  const isMigration = searchParams.get('migrate') === '1';

  const [step, setStep] = useState<'create' | 'recovery'>('create');
  const [username, setUsername] = useState(() => {
    // In migration mode, pre-fill username from the legacy auth store
    if (isMigration) {
      return useAuthStore.getState().user?.username || '';
    }
    return '';
  });
  const [displayName, setDisplayName] = useState(() => {
    if (isMigration) {
      return useAuthStore.getState().user?.display_name || '';
    }
    return '';
  });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [savedPhrase, setSavedPhrase] = useState(false);
  const navigate = useNavigate();
  const createAccount = useAccountStore((s) => s.create);
  const getRecoveryPhrase = useAccountStore((s) => s.getRecoveryPhrase);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (username.length < 2 || username.length > 32) {
      setError('Username must be between 2 and 32 characters.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await createAccount(username, password, displayName || undefined);

      // In migration mode: attach the new public key to the existing server account
      if (isMigration) {
        const publicKey = useAccountStore.getState().publicKey;
        if (publicKey) {
          try {
            await authApi.attachPublicKey(publicKey);
          } catch {
            // Non-fatal — server may not support it yet
          }
        }

        // Add current server to multi-server list
        const serverUrl = getStoredServerUrl() || getCurrentOriginServerUrl();
        if (serverUrl) {
          setStoredServerUrl(serverUrl);
          const token = useAuthStore.getState().token;
          let serverName = serverUrl;
          try {
            serverName = new URL(serverUrl).host;
          } catch {
            // Keep raw URL as name if parsing fails.
          }
          useServerListStore.getState().addServer(serverUrl, serverName, token || undefined);
        }
      }

      const phrase = getRecoveryPhrase();
      if (phrase) {
        setRecoveryPhrase(phrase);
        setStep('recovery');
      } else {
        navigate(isMigration ? '/app' : '/connect');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = () => {
    navigate(isMigration ? '/app' : '/connect');
  };

  if (step === 'recovery') {
    const words = recoveryPhrase.split(' ');
    return (
      <div className="auth-shell">
        <div className="auth-card mx-auto w-full max-w-lg">
          <div className="mb-6 text-center">
            <h1 className="text-3xl font-bold leading-tight text-text-primary">Recovery Phrase</h1>
            <p className="mt-2 text-sm text-text-muted">
              Write these words down and keep them safe. This is the <strong>only way</strong> to recover your account if you lose access.
            </p>
          </div>

          <div className="mb-6 rounded-xl border border-accent-warning/30 bg-accent-warning/10 px-4 py-3 text-sm font-medium text-accent-warning">
            Never share your recovery phrase. Anyone with these words can access your account.
          </div>

          <div className="mb-6 grid grid-cols-4 gap-3 rounded-xl border border-border-subtle bg-bg-mod-subtle/65 p-4">
            {words.map((word, i) => (
              <div key={i} className="card-surface flex items-center gap-1.5 rounded-lg border border-border-subtle/45 bg-bg-secondary/60 px-2 py-1.5">
                <span className="text-xs font-bold text-text-muted">{i + 1}.</span>
                <span className="text-sm font-medium text-text-primary">{word}</span>
              </div>
            ))}
          </div>

          <label className="mb-6 flex cursor-pointer items-start gap-2.5 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-3.5 py-3.5">
            <input
              type="checkbox"
              checked={savedPhrase}
              onChange={(e) => setSavedPhrase(e.target.checked)}
              className="mt-1 accent-[var(--accent-primary)]"
            />
            <span className="text-xs leading-5 text-text-muted">
              I have written down my recovery phrase and stored it in a safe place.
            </span>
          </label>

          <button
            onClick={handleContinue}
            disabled={!savedPhrase}
            className="btn-primary w-full"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <form onSubmit={handleCreate} className="auth-card mx-auto w-full max-w-md">
        <div className="mb-7 text-center">
          <h1 className="text-3xl font-bold leading-tight text-text-primary">
            {isMigration ? 'Secure Your Account' : 'Set Up Local Identity'}
          </h1>
          <p className="mt-1.5 text-sm text-text-muted">
            {isMigration
              ? 'Set up a cryptographic identity for your existing account. This lets you sign in to any server without a password.'
              : 'Optional: create a cryptographic identity on this device for challenge-response sign-in.'}
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-3 py-2.5 text-sm font-medium text-accent-danger">
            {error}
          </div>
        )}

        <div className="card-stack-roomy">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Username <span className="text-accent-danger">*</span>
            </span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={2}
              maxLength={32}
              className="input-field mt-2"
              placeholder="Choose a username"
              autoFocus
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Display Name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="input-field mt-2"
              placeholder="How others see you"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {isMigration ? 'New Encryption Password' : 'Password'} <span className="text-accent-danger">*</span>
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
            <p className="mt-1.5 text-xs text-text-muted">
              {isMigration
                ? 'This password encrypts your new account key on this device. It can be different from your server password.'
                : 'This password encrypts your account key on this device.'}
            </p>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Confirm Password <span className="text-accent-danger">*</span>
            </span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="input-field mt-2"
              placeholder="Type your password again"
            />
          </label>
        </div>

        <button type="submit" disabled={loading} className="btn-primary mt-8 w-full min-h-[2.9rem]">
          {loading ? 'Creating...' : isMigration ? 'Secure Account' : 'Create Identity'}
        </button>

        {!isMigration && (
          <p className="mt-5 text-center text-sm text-text-muted">
            Already have a server account?{' '}
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="font-semibold text-text-link hover:underline"
            >
              Sign in
            </button>
            {' \u00b7 '}
            <button
              type="button"
              onClick={() => navigate('/recover')}
              className="font-semibold text-text-link hover:underline"
            >
              Recover
            </button>
          </p>
        )}

        {isMigration && (
          <p className="mt-5 text-center text-sm text-text-muted">
            <button
              type="button"
              onClick={() => navigate('/app')}
              className="font-semibold text-text-link hover:underline"
            >
              Skip for now
            </button>
            {' \u2014 you can set this up later in Settings.'}
          </p>
        )}
      </form>
    </div>
  );
}
