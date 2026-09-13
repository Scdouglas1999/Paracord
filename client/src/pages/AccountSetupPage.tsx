import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { useAccountStore } from '../stores/accountStore';
import { attachAccountIdentity } from '../lib/crypto/attachAccountIdentity';
import { captureScopedOperation } from '../lib/operationContext';
import { getServerAccountScope, getServerUser } from '../lib/serverIdentity';
import { LOCAL_SERVER_ID } from '../lib/serverScope';
import { extractApiError } from '../api/client';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { AuthCanvas, AuthCard, AuthHeading, Field } from './authScaffold';

export function AccountSetupPage() {
  const [params] = useSearchParams();
  const serverId = params.get('server') ?? LOCAL_SERVER_ID;
  const homeUser = useAuthStore(s => s.user);
  const remoteUser = useServerListStore(s => {
    const server = s.servers.find(entry => entry.id === serverId);
    return server?.token && server.user?.id === server.userId ? server.user : null;
  });
  const user = serverId === LOCAL_SERVER_ID ? homeUser : remoteUser;
  if (params.get('migrate') === '1') {
    const expectedUser = params.get('user');
    if (!user || (expectedUser && expectedUser !== user.id)) {
      return (
        <AuthCanvas>
          <AuthCard className="max-w-md">
            <div className="flex flex-col items-start gap-4 p-7 sm:p-8">
              <AuthHeading
                title={user ? 'Account changed' : 'Waiting for your server account'}
                subtitle="Sign in to the intended server account before setting up encryption."
              />
              <p className="text-label text-text-secondary">
                Setup continues when that account is available.
              </p>
              <Link
                to="/app"
                className="pc-focusable rounded-[var(--radius-chip)] text-label font-semibold text-text-link underline underline-offset-4"
              >
                Return to Paracord
              </Link>
            </div>
          </AuthCard>
        </AuthCanvas>
      );
    }
  }
  return <OwnedAccountSetupPage key={`${serverId}:${user?.id ?? 'new'}`} />;
}

function OwnedAccountSetupPage() {
  const [searchParams] = useSearchParams();
  const isMigration = searchParams.get('migrate') === '1';
  const [scope] = useState(() => {
    const account = getServerAccountScope(searchParams.get('server') ?? LOCAL_SERVER_ID);
    const expectedUser = searchParams.get('user');
    return expectedUser && expectedUser !== account?.userId ? null : account;
  });
  const targetUser = scope ? getServerUser(scope.serverId) : null;
  const serverName = useServerListStore(s => scope?.serverId === LOCAL_SERVER_ID ? 'current server' : s.servers.find(server => server.id === scope?.serverId)?.name ?? 'unavailable server');
  const returnTo = searchParams.get('returnTo');
  const destination = returnTo?.startsWith('/app/') && !returnTo.includes('\\') ? returnTo : '/app';
  const existingIdentity = useAccountStore(s => s.publicKey);
  const hasSavedIdentity = useAccountStore(s => s.hasAccount());
  const identityUnlocked = useAccountStore(s => s.isUnlocked);
  const [serverPassword, setServerPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  const [step, setStep] = useState<'create' | 'recovery'>('create');
  const [username, setUsername] = useState(() => {
    // In migration mode, pre-fill username from the legacy auth store
    if (isMigration) {
      return targetUser?.username || '';
    }
    return '';
  });
  const [displayName, setDisplayName] = useState(() => {
    if (isMigration) {
      return targetUser?.display_name || '';
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
    if (!hasSavedIdentity && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!hasSavedIdentity && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (isMigration && !scope) {
      setError('Sign in to the intended server account before setting up encryption.');
      return;
    }
    setLoading(true);
    let context: ReturnType<typeof captureScopedOperation> | undefined;
    try {
      if (isMigration && scope) context = captureScopedOperation(scope);
      const account = useAccountStore.getState();
      if (context?.user.public_key && !account.hasAccount()) {
        throw new Error('This server account already has an identity. Restore its recovery phrase instead of creating a replacement.');
      }
      if (account.hasAccount()) {
        // Reuse the saved identity after a failed attach or reload. Never replace
        // a device's private key merely because server authentication failed.
        if (!account.isUnlocked) await account.unlock(password);
      } else {
        await createAccount(normalizedUsername, password, normalizedDisplayName || undefined);
      }
      if (context) await attachAccountIdentity(context, serverPassword, mfaCode.trim() || undefined);
      setPassword(''); setConfirmPassword(''); setServerPassword(''); setMfaCode('');

      const phrase = getRecoveryPhrase();
      if (phrase) {
        setRecoveryPhrase(phrase);
        setStep('recovery');
      } else {
        throw new Error('Unlock the saved identity to view and back up its recovery phrase.');
      }
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      context?.dispose();
      setLoading(false);
    }
  };

  const handleContinue = () => {
    navigate(isMigration ? destination : '/connect');
  };

  if (step === 'recovery') {
    const words = recoveryPhrase.split(' ');
    return (
      <AuthCanvas>
        <AuthCard className="max-w-lg">
          <div className="flex flex-col gap-6 p-7 sm:p-8">
            <div>
              <p className="text-section text-text-faint">Step 2 of 2</p>
              <AuthHeading
                mark={false}
                title="Recovery phrase"
                subtitle={
                  <>
                    These 24 words restore your identity key. They do not contain your encrypted messages or their session keys.
                    Write them down and store them somewhere safe.
                  </>
                }
              />
            </div>

            {/* A caution is a well carrying warning ink, never a tinted box
                with a coloured border (spec §1.1, §1.6). */}
            <div className="pc-well flex items-start gap-2.5 px-4 py-3 text-label text-accent-warning">
              <ShieldAlert size={16} className="mt-px shrink-0" />
              <span className="leading-relaxed">
                Never share these words. Anyone who has them can take over your account.
              </span>
            </div>

            <div>
              <div className="pc-well grid grid-cols-2 gap-2 p-4 sm:grid-cols-3">
                {words.map((word, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-[var(--radius-chip)] bg-bg-raised px-2.5 py-1.5 shadow-[var(--shadow-chip)]"
                  >
                    <span className="pc-mono text-meta text-text-faint">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="pc-mono text-label text-text-primary">{word}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                aria-label={copied ? 'Recovery phrase copied' : 'Copy recovery phrase'}
                onClick={handleCopyPhrase}
                className="pc-focusable mt-3 inline-flex h-[var(--h-control)] items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-meta font-semibold text-text-link transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied to clipboard' : 'Copy phrase'}
              </button>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] bg-bg-raised px-4 py-3.5 shadow-[var(--shadow-raised)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong">
              <input
                type="checkbox"
                checked={savedPhrase}
                onChange={(e) => setSavedPhrase(e.target.checked)}
                className="pc-checkbox mt-0.5"
              />
              <span className="text-label leading-relaxed text-text-secondary">
                I’ve written down my recovery phrase and stored it somewhere safe.
              </span>
            </label>

            <Button onClick={handleContinue} size="lg" disabled={!savedPhrase} className="w-full">
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
        <form onSubmit={handleCreate} className="flex flex-col gap-6 p-7 sm:p-8">
          <div>
            <p className="text-section text-text-faint">Step 1 of 2</p>
            <AuthHeading
              mark={false}
              title={isMigration ? 'Secure your account' : 'Set up a local identity'}
              subtitle={
                isMigration
                  ? 'Attach your device identity to this server account for encrypted messages and key-based sign-in.'
                  : 'Create a device-held identity for passwordless, challenge-response sign-in. Optional — you can skip it.'
              }
            />
          </div>

          {isMigration && scope && <p className="text-label text-text-secondary">Server account: {targetUser?.username} ({serverName})</p>}
          {existingIdentity && (
            <p className="text-meta text-text-secondary">
              Using saved identity <span className="pc-mono">{existingIdentity.slice(0, 12)}…</span>
            </p>
          )}
          {error && <ErrorBanner multiline message={error} />}

          <div className="flex flex-col gap-5">
            <Field label="Username" required>
              <Input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                minLength={2}
                maxLength={32}
                placeholder="ada"
                autoComplete="username"
                autoFocus
              />
            </Field>

            <Field label="Display name" hint="How others see you. You can change it later.">
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Ada Lovelace"
              />
            </Field>

            {(!hasSavedIdentity || !identityUnlocked) && <Field
              label={hasSavedIdentity ? 'Encryption password' : isMigration ? 'New encryption password' : 'Password'}
              required
              hint={
                hasSavedIdentity ? 'Unlocks the identity already saved on this device.' : isMigration
                  ? 'Encrypts your new account key on this device. It can differ from your server password.'
                  : 'Encrypts your account key on this device. At least 10 characters.'
              }
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={hasSavedIdentity ? undefined : MIN_PASSWORD_LENGTH}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                autoComplete={hasSavedIdentity ? "current-password" : "new-password"}
              />
            </Field>}

            {!hasSavedIdentity && <Field label="Confirm password" required>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                placeholder="Type your password again"
                autoComplete="new-password"
              />
            </Field>}

            {isMigration && <>
              <Field label="Current server password" required hint="Authenticates this change on the server. It can differ from your encryption password.">
                <Input type="password" value={serverPassword} onChange={e => setServerPassword(e.target.value)} required autoComplete="current-password" />
              </Field>
              <Field label="Two-factor or backup code" hint="Required if two-factor authentication is enabled on this server account.">
                <Input value={mfaCode} onChange={e => setMfaCode(e.target.value)} autoComplete="one-time-code" className="pc-mono" />
              </Field>
            </>}
          </div>

          <Button type="submit" size="lg" loading={loading} disabled={loading} className="w-full">
            <KeyRound size={16} aria-hidden />
            {isMigration ? 'Secure account' : 'Create identity'}
          </Button>

          {!isMigration ? (
            <p className="text-meta text-text-secondary">
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="pc-focusable rounded-[var(--radius-chip)] font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Sign in
              </button>
              {' · '}
              <button
                type="button"
                onClick={() => navigate('/recover')}
                className="pc-focusable rounded-[var(--radius-chip)] font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
              >
                Recover from phrase
              </button>
            </p>
          ) : (
            <p className="text-meta text-text-secondary">
              <button
                type="button"
                onClick={() => navigate('/app')}
                className="pc-focusable rounded-[var(--radius-chip)] font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
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
