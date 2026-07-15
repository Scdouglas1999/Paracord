import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { getStoredServerUrl, getCurrentOriginServerUrl, setStoredServerUrl } from '../lib/config/apiBaseUrl';
import { authApi } from '../api/auth';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { AuthCanvas, AuthCard, AuthHeading, Field } from './authScaffold';

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
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  const handleCopyPhrase = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(recoveryPhrase).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const createAccount = useAccountStore((s) => s.create);
  const getRecoveryPhrase = useAccountStore((s) => s.getRecoveryPhrase);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const normalizedUsername = username.trim();
    const normalizedDisplayName = displayName.trim();

    if (normalizedUsername.length < 2 || normalizedUsername.length > 32) {
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
      await createAccount(normalizedUsername, password, normalizedDisplayName || undefined);

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
      <AuthCanvas>
        <AuthCard className="max-w-lg">
          <div className="flex flex-col gap-6 p-8">
            <div>
              <p className="text-section uppercase text-accent-primary">Step 2 of 2</p>
              <AuthHeading
                mark={false}
                title="Recovery Phrase"
                subtitle={
                  <>
                    These 24 words are the <strong className="font-semibold text-text-primary">only</strong> way to
                    recover your account if you lose this device. Write them down and store them somewhere safe.
                  </>
                }
              />
            </div>

            <div className="flex items-start gap-2.5 rounded-md border border-accent-warning/30 bg-warning-tint px-4 py-3 text-label text-accent-warning">
              <ShieldAlert size={16} className="mt-px shrink-0" />
              <span>Never share these words. Anyone who has them can take over your account.</span>
            </div>

            <div>
              <div className="grid grid-cols-2 gap-2 rounded-md border border-border-subtle bg-bg-tertiary/50 p-4 sm:grid-cols-3">
                {words.map((word, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-sm bg-bg-secondary px-2.5 py-1.5"
                  >
                    <span className="font-code text-meta text-text-muted tabular-nums">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="font-code text-label text-text-primary">{word}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                aria-label={copied ? 'Recovery phrase copied' : 'Copy recovery phrase'}
                onClick={handleCopyPhrase}
                className="mt-3 inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-meta font-semibold text-text-link transition-colors hover:bg-accent-tint"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied to clipboard' : 'Copy phrase'}
              </button>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border-subtle bg-bg-mod-subtle px-4 py-3.5 transition-colors hover:border-border-strong">
              <input
                type="checkbox"
                checked={savedPhrase}
                onChange={(e) => setSavedPhrase(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent-primary)]"
              />
              <span className="text-label leading-relaxed text-text-secondary">
                I’ve written down my recovery phrase and stored it somewhere safe.
              </span>
            </label>

            <Button onClick={handleContinue} disabled={!savedPhrase} className="w-full">
              Continue
            </Button>
          </div>
        </AuthCard>
      </AuthCanvas>
    );
  }

  return (
    <AuthCanvas>
      <AuthCard className="max-w-md">
        <form onSubmit={handleCreate} className="flex flex-col gap-6 p-8">
          <div>
            <p className="text-section uppercase text-accent-primary">Step 1 of 2</p>
            <AuthHeading
              mark={false}
              title={isMigration ? 'Secure your account' : 'Set up a local identity'}
              subtitle={
                isMigration
                  ? 'Create a cryptographic identity for your existing account so you can sign in to any server without a password.'
                  : 'Create a device-held identity for passwordless, challenge-response sign-in. Optional — you can skip it.'
              }
            />
          </div>

          {error && <ErrorBanner message={error} />}

          <div className="flex flex-col gap-5">
            <Field label="Username" required>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                minLength={2}
                maxLength={32}
                className="input-field"
                placeholder="ada"
                autoComplete="username"
                autoFocus
              />
            </Field>

            <Field label="Display Name" hint="How others see you. You can change it later.">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input-field"
                placeholder="Ada Lovelace"
              />
            </Field>

            <Field
              label={isMigration ? 'New Encryption Password' : 'Password'}
              required
              hint={
                isMigration
                  ? 'Encrypts your new account key on this device — it can differ from your server password.'
                  : 'Encrypts your account key on this device. At least 10 characters.'
              }
            >
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={MIN_PASSWORD_LENGTH}
                className="input-field"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                autoComplete="new-password"
              />
            </Field>

            <Field label="Confirm Password" required>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="input-field"
                placeholder="Type your password again"
                autoComplete="new-password"
              />
            </Field>
          </div>

          <Button type="submit" loading={loading} disabled={loading} className="w-full">
            <KeyRound size={16} className="mr-1.5" />
            {isMigration ? 'Secure Account' : 'Create Identity'}
          </Button>

          {!isMigration ? (
            <p className="text-label text-text-secondary">
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Sign in
              </button>
              {' · '}
              <button
                type="button"
                onClick={() => navigate('/recover')}
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Recover from phrase
              </button>
            </p>
          ) : (
            <p className="text-label text-text-secondary">
              <button
                type="button"
                onClick={() => navigate('/app')}
                className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Skip for now
              </button>
              {' — you can set this up later in Settings.'}
            </p>
          )}
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}
