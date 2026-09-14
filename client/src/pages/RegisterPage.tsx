import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuthStore } from '../stores/authStore';
import { authApi } from '../api/auth';
import { instanceApi } from '../api/instance';
import { extractApiError } from '../api/client';
import {
  PASSWORD_REQUIREMENTS_HINT,
  registrationPasswordError,
} from '../lib/registrationPassword';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import {
  AUTH_FORM,
  AppMark,
  AuthCanvas,
  AuthCard,
  AuthScroll,
  AuthStep,
  AuthSteps,
  Field,
  useFocusRejectedField,
} from './authScaffold';

/** The fields a registration collects, and where a rejection belongs. */
export type RegisterField = 'email' | 'username' | 'password' | 'confirmPassword' | 'agreed';

export interface RegisterDraft {
  email: string;
  displayName: string;
  username: string;
  password: string;
  confirmPassword: string;
  agreed: boolean;
}

/**
 * Two steps, because the window is 940×560 at its smallest and five fields plus
 * a terms box do not fit in it — and because they are two different questions.
 * Who you are is a set of choices; the password and the agreement are the thing
 * that actually creates the account.
 */
export const REGISTER_STEPS = ['identity', 'password'] as const;
export type RegisterStepId = (typeof REGISTER_STEPS)[number];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What is wrong with one step of the registration, or nothing. */
export function registerStepError(
  stepId: RegisterStepId,
  draft: RegisterDraft,
  options: { requireEmail: boolean },
): { field: RegisterField; message: string } | null {
  const trimmedEmail = draft.email.trim();
  if (stepId === 'identity') {
    if (options.requireEmail && !trimmedEmail) {
      return { field: 'email', message: 'This instance requires an email address.' };
    }
    if (trimmedEmail && !EMAIL_SHAPE.test(trimmedEmail)) {
      return { field: 'email', message: 'That doesn’t look like an email address.' };
    }
    if (!draft.username.trim()) {
      return { field: 'username', message: 'Username is required.' };
    }
    return null;
  }
  const passwordError = registrationPasswordError(draft.password);
  if (passwordError) return { field: 'password', message: passwordError };
  if (draft.password !== draft.confirmPassword) {
    return { field: 'confirmPassword', message: 'Passwords do not match.' };
  }
  if (!draft.agreed) {
    return { field: 'agreed', message: 'You must agree to the terms of service' };
  }
  return null;
}

export function RegisterPage() {
  const emailErrorId = useId();
  const usernameErrorId = useId();
  const passwordHintId = useId();
  const passwordErrorId = useId();
  const confirmErrorId = useId();
  const termsErrorId = useId();

  const [draft, setDraft] = useState<RegisterDraft>({
    email: '',
    displayName: '',
    username: '',
    password: '',
    confirmPassword: '',
    agreed: false,
  });
  const [stepIndex, setStepIndex] = useState(0);
  const [fieldError, setFieldError] = useState<{ field: RegisterField; message: string } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [requireEmail, setRequireEmail] = useState(false);
  const navigate = useNavigate();
  const register = useAuthStore((s) => s.register);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRejectedField(formRef, fieldError);

  const stepId = REGISTER_STEPS[stepIndex];
  const isLastStep = stepIndex === REGISTER_STEPS.length - 1;

  const edit = useCallback(<K extends keyof RegisterDraft>(field: K, value: RegisterDraft[K]) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setFieldError((previous) => (previous?.field === field ? null : previous));
  }, []);

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

  // Registration is closed until the server has an owner, and the server would
  // reject this form anyway. Send the operator to the claim flow rather than
  // letting them fill in a page that cannot succeed.
  useEffect(() => {
    let cancelled = false;
    instanceApi
      .getSetupStatus()
      .then(({ data }) => {
        if (!cancelled && data.setup_required) navigate('/setup-server', { replace: true });
      })
      .catch(() => {
        // Never infer setup state from a failed request; submitting reports the
        // real error.
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const errorFor = (field: RegisterField) =>
    fieldError?.field === field ? fieldError.message : null;

  const createAccount = async () => {
    for (const [index, candidate] of REGISTER_STEPS.entries()) {
      const failure = registerStepError(candidate, draft, { requireEmail });
      if (failure) {
        setStepIndex(index);
        setFieldError(failure);
        return;
      }
    }

    setError('');
    setLoading(true);
    try {
      await register(
        draft.email.trim(),
        draft.username.trim(),
        draft.password,
        draft.displayName.trim(),
      );

      // Go straight to the app — legacy token auth works without a local
      // keypair. Users can set up a local crypto identity later in Settings.
      navigate('/app');
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  /** Enter in any field does what the visible button does. */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    const failure = registerStepError(stepId, draft, { requireEmail });
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
    await createAccount();
  };

  const goBack = () => {
    // Nothing typed is cleared on the way back.
    setFieldError(null);
    setError('');
    setStepIndex((index) => Math.max(0, index - 1));
  };

  const confirmMismatch =
    draft.confirmPassword.length > 0 && draft.password !== draft.confirmPassword;
  const progress = <AuthSteps step={stepIndex + 1} count={REGISTER_STEPS.length} />;

  return (
    <AuthCanvas>
      <AuthCard className="max-w-md short-window:max-w-2xl">
        <form ref={formRef} onSubmit={handleSubmit} noValidate className={AUTH_FORM}>
          <header className="flex items-center gap-3">
            <AppMark size={34} />
            <h1 className="pc-display text-title text-text-primary">Create your account</h1>
          </header>

          {error && <ErrorBanner multiline message={error} />}

          {stepId === 'identity' && (
            <AuthStep
              key="identity"
              dense
              progress={progress}
              title="Who you are here"
              description="Claim a username, and you’re in — you can join servers and add a recovery identity next."
            >
              <AuthScroll paired>
                <Field
                  label="Email"
                  required={requireEmail}
                  error={errorFor('email')}
                  hint={requireEmail ? undefined : 'Optional — used only for password recovery.'}
                  descriptionId={emailErrorId}
                >
                  <Input
                    type="email"
                    value={draft.email}
                    onChange={(e) => edit('email', e.target.value)}
                    required={requireEmail}
                    placeholder={requireEmail ? 'you@example.com' : 'you@example.com (optional)'}
                    autoComplete="email"
                    error={Boolean(errorFor('email'))}
                    aria-invalid={Boolean(errorFor('email')) || undefined}
                    aria-describedby={
                      errorFor('email') || !requireEmail ? emailErrorId : undefined
                    }
                  />
                </Field>

                <Field label="Display name" hint="How people see you. You can change it anytime.">
                  <Input
                    type="text"
                    value={draft.displayName}
                    onChange={(e) => edit('displayName', e.target.value)}
                    placeholder="Ada Lovelace"
                  />
                </Field>

                <Field
                  label="Username"
                  required
                  error={errorFor('username')}
                  hint="Your unique @handle on this instance."
                  descriptionId={usernameErrorId}
                >
                  <Input
                    type="text"
                    value={draft.username}
                    onChange={(e) => edit('username', e.target.value)}
                    required
                    placeholder="ada"
                    autoComplete="username"
                    error={Boolean(errorFor('username'))}
                    aria-invalid={Boolean(errorFor('username')) || undefined}
                    aria-describedby={usernameErrorId}
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
              title="Choose a password"
              description="This is what signs you in on every device. Nobody here can read it back to you."
            >
              <AuthScroll paired>
                <Field
                  label="Password"
                  required
                  error={errorFor('password')}
                  descriptionId={passwordErrorId}
                >
                  <Input
                    type="password"
                    value={draft.password}
                    onChange={(e) => edit('password', e.target.value)}
                    required
                    placeholder="Choose a strong password"
                    autoComplete="new-password"
                    error={Boolean(errorFor('password'))}
                    aria-invalid={Boolean(errorFor('password')) || undefined}
                    aria-describedby={
                      errorFor('password') ? `${passwordErrorId} ${passwordHintId}` : passwordHintId
                    }
                  />
                </Field>

                <Field
                  label="Confirm password"
                  required
                  error={
                    errorFor('confirmPassword') ??
                    (confirmMismatch ? 'These passwords don’t match yet.' : null)
                  }
                  descriptionId={confirmErrorId}
                >
                  <Input
                    type="password"
                    value={draft.confirmPassword}
                    onChange={(e) => edit('confirmPassword', e.target.value)}
                    required
                    placeholder="Re-enter your password"
                    autoComplete="new-password"
                    error={Boolean(errorFor('confirmPassword')) || confirmMismatch}
                    aria-describedby={
                      errorFor('confirmPassword') || confirmMismatch ? confirmErrorId : undefined
                    }
                    aria-invalid={
                      Boolean(errorFor('confirmPassword')) || confirmMismatch || undefined
                    }
                  />
                </Field>

                {/* One statement of the rules, at the full measure, under both
                    boxes it governs — rather than a four-line column beside a
                    field half its width. */}
                <p
                  id={passwordHintId}
                  className="pc-auth-span text-meta leading-relaxed text-text-faint"
                >
                  {PASSWORD_REQUIREMENTS_HINT}
                </p>
              </AuthScroll>
            </AuthStep>
          )}

          {stepId === 'password' && (
              <div>
                <label className="flex cursor-pointer items-start gap-3 rounded-well border border-border-subtle bg-bg-mod-subtle px-4 py-3.5 transition-colors hover:border-border-strong">
                  <input
                    type="checkbox"
                    checked={draft.agreed}
                    onChange={(e) => edit('agreed', e.target.checked)}
                    className="pc-checkbox mt-0.5"
                    aria-invalid={Boolean(errorFor('agreed')) || undefined}
                    aria-describedby={errorFor('agreed') ? termsErrorId : undefined}
                  />
                  <span className="text-meta leading-relaxed text-text-secondary">
                    I have read and agree to the{' '}
                    <Link
                      to="/terms"
                      className="font-semibold text-text-link hover:text-accent-primary-hover"
                    >
                      Terms of Service
                    </Link>{' '}
                    and{' '}
                    <Link
                      to="/privacy"
                      className="font-semibold text-text-link hover:text-accent-primary-hover"
                    >
                      Privacy Policy
                    </Link>
                    .
                  </span>
                </label>
                {errorFor('agreed') && (
                  <p id={termsErrorId} className="mt-2 text-meta text-accent-danger">
                    {errorFor('agreed')}
                  </p>
                )}
              </div>
          )}

          <div className="flex items-center gap-3">
            {stepIndex > 0 && (
              <Button type="button" variant="ghost" size="lg" onClick={goBack} disabled={loading}>
                Back
              </Button>
            )}
            <Button type="submit" size="lg" loading={loading} disabled={loading} className="flex-1">
              {isLastStep ? 'Create account' : 'Continue'}
            </Button>
          </div>

          <p className="text-label text-text-secondary">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-semibold text-text-link transition-colors hover:text-accent-primary-hover"
            >
              Sign in
            </Link>
          </p>
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}
