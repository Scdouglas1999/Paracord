import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAccountStore } from '../stores/accountStore';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { ErrorBanner } from '../components/ui/Feedback';
import { Input, Textarea } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import {
  AUTH_FORM,
  AuthCanvas,
  AuthCard,
  AuthHeading,
  AuthScroll,
  AuthStep,
  AuthSteps,
  Field,
  useFocusRejectedField,
} from './authScaffold';
import {
  completeRecoverMfa,
  credentialErrorMessage,
  newPasswordProblem,
  recoverWithPhrase,
  setPasswordAfterRecovery,
  useCredentialMode,
  type RecoveredSession,
  type RecoverOutcome,
} from '../lib/oneCredential';

/** Where a rejection belongs on the recovery form. */
export type RecoverField = 'phrase' | 'username' | 'password' | 'confirmPassword';

export interface RecoverDraft {
  phrase: string;
  username: string;
  password: string;
  confirmPassword: string;
}

/**
 * Two steps: the phrase that proves who you are, then the password that
 * protects the key it restores. They are separate questions and — with a
 * four-row phrase box in the first — they do not share a 940×560 window.
 */
export const RECOVER_STEPS = ['phrase', 'password'] as const;
export type RecoverStepId = (typeof RECOVER_STEPS)[number];

/** What is wrong with one step of the recovery, or nothing. */
export function recoverStepError(
  stepId: RecoverStepId,
  draft: RecoverDraft,
): { field: RecoverField; message: string } | null {
  if (stepId === 'phrase') {
    const words = draft.phrase.trim().split(/\s+/).filter(Boolean);
    if (words.length !== 24) {
      return { field: 'phrase', message: 'Recovery phrase must be exactly 24 words.' };
    }
    const username = draft.username.trim();
    if (username.length < 2 || username.length > 32) {
      return { field: 'username', message: 'Username must be between 2 and 32 characters.' };
    }
    return null;
  }
  if (draft.password.length < MIN_PASSWORD_LENGTH) {
    return {
      field: 'password',
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (draft.password !== draft.confirmPassword) {
    return { field: 'confirmPassword', message: 'Passwords do not match.' };
  }
  return null;
}

export function AccountRecoverPage() {
  const [draft, setDraft] = useState<RecoverDraft>({
    phrase: '',
    username: '',
    password: '',
    confirmPassword: '',
  });
  const [stepIndex, setStepIndex] = useState(0);
  const [fieldError, setFieldError] = useState<{ field: RecoverField; message: string } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const recover = useAccountStore((s) => s.recover);
  // One password (docs/setup-spec.md §3.8): sign in with the phrase's key,
  // then choose a new password for every device. Older servers keep the
  // device-only recovery below (§3.12).
  const credentialMode = useCredentialMode();
  const onePassword = credentialMode === 'one-password';
  const [pendingMfa, setPendingMfa] = useState<Extract<RecoverOutcome, { kind: 'mfa' }> | null>(null);
  const [recovered, setRecovered] = useState<RecoveredSession | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRejectedField(formRef, fieldError);

  const stepId = RECOVER_STEPS[stepIndex];
  const isLastStep = stepIndex === RECOVER_STEPS.length - 1;

  const edit = useCallback((field: keyof RecoverDraft, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setFieldError((previous) => (previous?.field === field ? null : previous));
  }, []);

  const errorFor = (field: RecoverField) =>
    fieldError?.field === field ? fieldError.message : null;

  const runRecovery = async () => {
    for (const [index, candidate] of RECOVER_STEPS.entries()) {
      const failure = recoverStepError(candidate, draft);
      if (failure) {
        setStepIndex(index);
        setFieldError(failure);
        return;
      }
    }

    if (onePassword) {
      await runOnePasswordRecovery();
      return;
    }
    setLoading(true);
    try {
      await recover(draft.phrase.trim(), draft.username.trim(), draft.password);
      navigate('/app');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Recovery failed. Check your phrase and try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const runOnePasswordRecovery = async () => {
    const problem = await newPasswordProblem(draft.password, { username: draft.username.trim() });
    if (problem) {
      setFieldError({ field: 'password', message: problem });
      return;
    }
    setError('');
    setLoading(true);
    try {
      let session = recovered;
      if (!session) {
        if (pendingMfa) {
          session = await completeRecoverMfa(pendingMfa, mfaCode);
          setPendingMfa(null);
        } else {
          const outcome = await recoverWithPhrase(draft.phrase.trim(), draft.username.trim());
          if (outcome.kind === 'mfa') {
            setPendingMfa(outcome);
            setError('Enter the code from your authenticator app to continue.');
            return;
          }
          session = outcome.recovered;
        }
        setRecovered(session);
      }
      await setPasswordAfterRecovery(session, draft.password, mfaCode || undefined);
      setRecovered(null);
      navigate('/app');
    } catch (err) {
      setError(credentialErrorMessage(err, 'Recovery failed. Check your phrase and try again.'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    const failure = recoverStepError(stepId, draft);
    if (failure) {
      setFieldError(failure);
      return;
    }
    setFieldError(null);

    if (!isLastStep) {
      setError('');
      setStepIndex((index) => index + 1);
      return;
    }
    await runRecovery();
  };

  const goBack = () => {
    setFieldError(null);
    setError('');
    setStepIndex((index) => Math.max(0, index - 1));
  };

  const progress = <AuthSteps step={stepIndex + 1} count={RECOVER_STEPS.length} />;

  return (
    <AuthCanvas>
      <AuthCard className="short-window:max-w-2xl">
        <form ref={formRef} onSubmit={handleSubmit} noValidate className={AUTH_FORM}>
          <AuthHeading title="Recover your account" />

          {error && <ErrorBanner multiline message={error} />}

          {stepId === 'phrase' && (
            <AuthStep
              key="phrase"
              dense
              progress={progress}
              title="Enter your recovery phrase"
              description={onePassword
                ? 'The 24 words you saved when you made your account. They prove the account is yours, then you choose a new password.'
                : 'The phrase restores your identity — the key everyone you talk to verifies. It does not carry your messages: this device sets up fresh encryption keys, so conversations from before stay as “Encrypted message” here unless you import the account’s encrypted backup from Settings › Identity portability.'}
            >
              <AuthScroll paired>
                <Field
                  label="Recovery phrase"
                  required
                  error={errorFor('phrase')}
                  hint="All 24 words, in order, separated by spaces."
                  className="pc-auth-span"
                >
                  <Textarea
                    value={draft.phrase}
                    onChange={(e) => edit('phrase', e.target.value)}
                    required
                    rows={3}
                    className="pc-mono resize-none"
                    placeholder="ridge harbor velvet … (24 words)"
                    error={Boolean(errorFor('phrase'))}
                    aria-invalid={Boolean(errorFor('phrase')) || undefined}
                  />
                </Field>

                <Field label="Username" required error={errorFor('username')}>
                  <Input
                    type="text"
                    value={draft.username}
                    onChange={(e) => edit('username', e.target.value)}
                    required
                    placeholder="ada"
                    autoComplete="username"
                    error={Boolean(errorFor('username'))}
                    aria-invalid={Boolean(errorFor('username')) || undefined}
                  />
                </Field>
              </AuthScroll>
            </AuthStep>
          )}

          {stepId === 'password' && (
            <AuthStep
              key="password"
              dense
              progress={progress}
              title="Protect the restored key"
              description={onePassword
                ? 'Your new password replaces the old one on every device. Other devices sign in again with it.'
                : 'This password encrypts the recovered identity on this device. It can be a new one — nothing on the old device has to know it.'}
            >
              <AuthScroll paired>
                <Field
                  label="New password"
                  required
                  error={errorFor('password')}
                  hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                >
                  <Input
                    type="password"
                    value={draft.password}
                    onChange={(e) => edit('password', e.target.value)}
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    placeholder="Choose a strong password"
                    autoComplete="new-password"
                    error={Boolean(errorFor('password'))}
                    aria-invalid={Boolean(errorFor('password')) || undefined}
                  />
                </Field>

                {pendingMfa && (
                  <Field label="Two-factor code" required hint="Enter the code from your authenticator app.">
                    <Input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value)}
                      className="pc-mono"
                    />
                  </Field>
                )}

                <Field label="Confirm password" required error={errorFor('confirmPassword')}>
                  <Input
                    type="password"
                    value={draft.confirmPassword}
                    onChange={(e) => edit('confirmPassword', e.target.value)}
                    required
                    placeholder="Type your password again"
                    autoComplete="new-password"
                    error={Boolean(errorFor('confirmPassword'))}
                    aria-invalid={Boolean(errorFor('confirmPassword')) || undefined}
                  />
                </Field>
              </AuthScroll>
            </AuthStep>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={stepIndex > 0 ? goBack : () => navigate(-1)}
              disabled={loading}
            >
              Back
            </Button>
            <Button type="submit" size="lg" loading={loading} disabled={loading} className="flex-1">
              {isLastStep ? 'Recover account' : 'Continue'}
            </Button>
          </div>
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}
