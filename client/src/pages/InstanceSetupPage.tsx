import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../stores/authStore';
import { instanceApi, type PasswordRequirements } from '../api/instance';
import { authApi } from '../api/auth';
import { extractApiError } from '../api/client';
import { setAccessToken, setRefreshToken } from '../lib/authToken';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  PASSWORD_REQUIREMENTS_HINT,
  registrationPasswordError,
} from '../lib/registrationPassword';
import { ErrorBanner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import {
  AUTH_FORM,
  AuthCanvas,
  AuthCard,
  AuthScroll,
  AuthStep,
  AuthSteps,
  AppMark,
  Field,
  useFocusRejectedField,
} from './authScaffold';
import type { User } from '../types';

/**
 * Whether the rules this page advertises still match the ones the server
 * enforces. The page validates locally so it can explain a bad password before
 * submit, but that mirror is only trustworthy while it agrees with the server —
 * so the disagreement is surfaced rather than discovered as a rejected submit.
 */
export function passwordRulesMismatch(requirements: PasswordRequirements | null): string | null {
  if (!requirements) return null;
  if (
    requirements.min_length !== PASSWORD_MIN_BYTES ||
    requirements.max_length !== PASSWORD_MAX_BYTES ||
    !requirements.requires_uppercase ||
    !requirements.requires_lowercase ||
    !requirements.requires_digit ||
    !requirements.requires_symbol
  ) {
    return `This instance enforces different password rules than this page describes: ${requirements.min_length}–${requirements.max_length} ${requirements.length_unit === 'utf8_bytes' ? 'bytes' : 'characters'}, uppercase ${requirements.requires_uppercase ? 'required' : 'not required'}, lowercase ${requirements.requires_lowercase ? 'required' : 'not required'}, digit ${requirements.requires_digit ? 'required' : 'not required'}, symbol ${requirements.requires_symbol ? 'required' : 'not required'}. Follow the instance's rules.`;
  }
  return null;
}

/**
 * What went wrong with a claim, said in words an operator can act on.
 *
 * `POST /setup/claim` answers a token that does not match with a bare 401, and
 * `ApiError::Unauthorized` carries no message — so `extractApiError` yields the
 * raw wire string "unauthorized". Rendering that as the error on the very first
 * screen of the product tells the operator nothing and reads like a crash.
 * A 401 from this endpoint has exactly one cause, so name it. Every other
 * status already carries an operator-authored sentence from the server
 * (no token provisioned, already claimed, username taken, password rules) and
 * is passed through untouched.
 */
function claimFailureMessage(err: unknown): string {
  const message = extractApiError(err);
  if (setupCodeWasRefused(err)) {
    return 'That setup code is not the one your server printed. Open the setup link it printed again, or copy the code from first-owner-claim.txt next to the server’s config — it is case-sensitive.';
  }
  return message || 'Setup failed. Check the setup code and try again.';
}

function setupCodeWasRefused(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 401 || extractApiError(err) === 'unauthorized';
}

/**
 * The setup code, when the owner arrived by the link their server printed.
 *
 * The server and the installers print `…/setup-server#claim=<code>` and open it
 * in the browser, so the first thing a new owner is asked is their name, not to
 * go and find a code in a terminal. It rides in the FRAGMENT because a fragment
 * is never sent to the server, so the code reaches no access log; and it is
 * scrubbed from the address bar the moment it is read, so it is not left in
 * history or copied along with the URL.
 */
export function takeSetupCodeFromLocation(
  location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState'> = window.history,
): string | null {
  const match = /(?:^#|&)claim=([^&]+)/.exec(location.hash);
  if (!match) return null;
  let code: string;
  try {
    code = decodeURIComponent(match[1]).trim();
  } catch {
    return null;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  // What the server mints is long and alphanumeric. Anything else is not a
  // code, and is not worth offering to the claim endpoint.
  return /^[A-Za-z0-9_-]{16,256}$/.test(code) ? code : null;
}

/**
 * The fields this page collects, and the field a rejection belongs to.
 *
 * A message that names a field is rendered under that field with the danger
 * edge on the control (`cf75db8`); the banner is kept for what has no field to
 * belong to — the server refusing the whole claim.
 */
export type ClaimField =
  | 'token'
  | 'username'
  | 'email'
  | 'password'
  | 'confirmPassword'
  | 'instanceName'
  | 'spaceName';

export interface ClaimDraft {
  token: string;
  username: string;
  displayName: string;
  email: string;
  password: string;
  confirmPassword: string;
  instanceName: string;
  spaceName: string;
}

/**
 * The wizard, as data.
 *
 * Four things are being asked for and the window is 940×500 at its smallest,
 * so they are four steps rather than four sections of one long page. The split
 * follows the thing being decided, not an even division of fields: proving you
 * run the machine, who the owner is, what protects that account, and what the
 * place is called.
 */
export const CLAIM_STEPS = [
  { id: 'token', fields: ['token'] },
  { id: 'owner', fields: ['username', 'email'] },
  { id: 'password', fields: ['password', 'confirmPassword'] },
  { id: 'place', fields: ['instanceName', 'spaceName'] },
] as const satisfies ReadonlyArray<{ id: string; fields: readonly ClaimField[] }>;

export type ClaimStepId = (typeof CLAIM_STEPS)[number]['id'];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What is wrong with one step, or nothing. Exported because the step gate is
 * the part of this page most worth testing directly: every rule below is one
 * the server also enforces, and a drift between them is a rejected submit the
 * operator cannot explain.
 */
export function claimStepError(
  stepId: ClaimStepId,
  draft: ClaimDraft,
  options: { requireEmail: boolean },
): { field: ClaimField; message: string } | null {
  const trimmedEmail = draft.email.trim();
  switch (stepId) {
    case 'token':
      if (!draft.token.trim()) {
        return {
          field: 'token',
          message: 'Paste the setup code your server printed to continue.',
        };
      }
      return null;
    case 'owner':
      if (!draft.username.trim()) {
        return { field: 'username', message: 'Choose a username for the owner account.' };
      }
      if (options.requireEmail && !trimmedEmail) {
        return { field: 'email', message: 'This instance requires an email address.' };
      }
      if (trimmedEmail && !EMAIL_SHAPE.test(trimmedEmail)) {
        return { field: 'email', message: 'That doesn’t look like an email address.' };
      }
      return null;
    case 'password': {
      const passwordError = registrationPasswordError(draft.password);
      if (passwordError) return { field: 'password', message: passwordError };
      if (draft.password !== draft.confirmPassword) {
        return { field: 'confirmPassword', message: 'Passwords do not match.' };
      }
      return null;
    }
    case 'place':
      if (!draft.instanceName.trim()) {
        return {
          field: 'instanceName',
          message: 'Give this instance a name so people know where they are.',
        };
      }
      if (draft.spaceName.trim().length < 2) {
        return {
          field: 'spaceName',
          message: 'Name the first server — at least 2 characters.',
        };
      }
      return null;
  }
}

/**
 * The first-owner claim. An unclaimed server has no accounts at all, so this is
 * the only page on it that can create one — and it needs the one-time token the
 * server printed in its own terminal, which is what proves the person filling
 * this in is the person running the machine.
 *
 * It is a wizard because the content is a wizard: four separate decisions, each
 * of which fits the window on its own, with the one action always on screen.
 * Stepping back never costs a typed value — the draft lives here, above the
 * steps, and the payload the last step submits is the same one the single long
 * form used to send.
 */
export function InstanceSetupPage() {
  const tokenHintId = useId();
  const usernameErrorId = useId();
  const emailErrorId = useId();
  const passwordHintId = useId();
  const passwordErrorId = useId();
  const confirmErrorId = useId();
  const instanceErrorId = useId();
  const spaceErrorId = useId();
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [requirements, setRequirements] = useState<PasswordRequirements | null>(null);
  const [requireEmail, setRequireEmail] = useState(false);

  // Read once, on the first render: reading it scrubs it from the address bar.
  const [codeFromLink] = useState(() => takeSetupCodeFromLocation());
  // Off again if the server refuses the code, so the field comes back.
  const [usingLinkCode, setUsingLinkCode] = useState(codeFromLink != null);

  const [draft, setDraft] = useState<ClaimDraft>({
    token: codeFromLink ?? '',
    username: '',
    displayName: '',
    email: '',
    password: '',
    confirmPassword: '',
    instanceName: '',
    spaceName: '',
  });
  const [stepIndex, setStepIndex] = useState(codeFromLink != null ? 1 : 0);
  const [fieldError, setFieldError] = useState<{ field: ClaimField; message: string } | null>(null);

  const [error, setError] = useState('');
  // Bumped on every rejection so an identical repeat still re-announces.
  const [errorSeq, setErrorSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRejectedField(formRef, fieldError);

  // Arriving by the link answers the first step already, so it is not shown
  // and not counted.
  const firstStepIndex = usingLinkCode ? 1 : 0;
  const step = CLAIM_STEPS[stepIndex];
  const isLastStep = stepIndex === CLAIM_STEPS.length - 1;

  /**
   * Typing into a field withdraws the rejection against it. A message that
   * survives the edit that answers it reads like the field is still wrong.
   */
  const edit = useCallback(
    (field: keyof ClaimDraft, value: string) => {
      setDraft((previous) => ({ ...previous, [field]: value }));
      setFieldError((previous) => (previous?.field === field ? null : previous));
    },
    [],
  );

  // The banner carries what belongs to no field — the server refusing the
  // claim. Focus moves to it so the rejection is announced, not only drawn.
  const rejectWith = useCallback((message: string) => {
    setError(message);
    setErrorSeq((seq) => seq + 1);
  }, []);

  useEffect(() => {
    if (!error) return;
    const node = errorRef.current;
    if (!node) return;
    // jsdom (and older embedded webviews) do not implement scrollIntoView;
    // focus alone still moves the viewport there, so this must never throw.
    // Instant, not smooth: an animated scroll is a delay before the operator
    // learns their submit was rejected, and it is what "prefers reduced motion"
    // asks us not to do.
    node.scrollIntoView?.({ block: 'center' });
    node.focus();
  }, [error, errorSeq]);

  // An already-claimed server must not keep showing a claim form: it would
  // invite someone to type a token that can never work again.
  useEffect(() => {
    let cancelled = false;
    instanceApi
      .getSetupStatus()
      .then(({ data }) => {
        if (cancelled) return;
        if (!data.setup_required) {
          navigate('/login', { replace: true });
          return;
        }
        setChecking(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatusError(
          extractApiError(err) ||
            'Could not reach this instance to check whether it has been set up. Check that it is running and reload.',
        );
        setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // The password rules come from the same server that enforces them.
  useEffect(() => {
    let cancelled = false;
    instanceApi
      .getPasswordRequirements()
      .then(({ data }) => {
        if (!cancelled) setRequirements(data);
      })
      .catch(() => {
        // The hint below still describes the rules this build ships with; a
        // genuine disagreement would have to come from a server that answered.
      });
    authApi
      .options()
      .then(({ data }) => {
        if (!cancelled) setRequireEmail(data.require_email);
      })
      .catch(() => {
        // Conservative default: email stays optional in the UI and the server
        // decides on submit.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rulesMismatch = useMemo(() => passwordRulesMismatch(requirements), [requirements]);

  const errorFor = (field: ClaimField) =>
    fieldError?.field === field ? fieldError.message : null;

  const submitClaim = async () => {
    // Every step, not only the last: a value can be cleared after the step that
    // owns it was passed, and the server would answer that with a 4xx the
    // operator has to translate back into a field.
    for (const [index, candidate] of CLAIM_STEPS.entries()) {
      const failure = claimStepError(candidate.id, draft, { requireEmail });
      if (failure) {
        setStepIndex(index);
        setFieldError(failure);
        return;
      }
    }

    setError('');
    setLoading(true);
    try {
      const { data } = await instanceApi.claimInstance({
        token: draft.token.trim(),
        username: draft.username.trim(),
        email: draft.email.trim() || undefined,
        password: draft.password,
        instance_name: draft.instanceName.trim(),
        initial_space_name: draft.spaceName.trim(),
        display_name: draft.displayName.trim() || undefined,
      });
      setAccessToken(data.token);
      setRefreshToken(data.refresh_token ?? null);
      useAuthStore.setState({ token: data.token, user: data.user as User });
      await useAuthStore.getState().fetchUser();
      navigate(`/app/guilds/${data.space.id}`, { replace: true });
    } catch (err: unknown) {
      rejectWith(claimFailureMessage(err));
      if (setupCodeWasRefused(err)) {
        // The code from the link did not work. Put the field back in front of
        // them with what they typed elsewhere intact.
        setUsingLinkCode(false);
        setStepIndex(0);
      }
      setLoading(false);
    }
  };

  /**
   * One submit handler for the whole wizard, so Enter in any field does what
   * the visible button does — advance, or claim on the last step.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    const failure = claimStepError(step.id, draft, { requireEmail });
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
    await submitClaim();
  };

  const goBack = () => {
    if (stepIndex === firstStepIndex) return;
    // Nothing is validated on the way back and nothing is cleared: a half-typed
    // value is still the operator's work.
    setFieldError(null);
    setError('');
    setStepIndex((index) => index - 1);
  };

  if (checking) {
    return (
      <AuthCanvas>
        <AuthCard className="max-w-md">
          <div className={AUTH_FORM}>
            <AppMark size={40} />
            <p className="mt-6 text-body text-text-secondary">Checking this instance…</p>
          </div>
        </AuthCard>
      </AuthCanvas>
    );
  }

  const progress = (
    <AuthSteps step={stepIndex + 1 - firstStepIndex} count={CLAIM_STEPS.length - firstStepIndex} />
  );

  return (
    <AuthCanvas>
      <AuthCard className="max-w-lg short-window:max-w-2xl">
        <form ref={formRef} onSubmit={handleSubmit} noValidate className={AUTH_FORM}>
          <header className="flex items-center gap-3">
            <AppMark size={34} />
            <h1 className="pc-display text-title text-text-primary">
              Set up your Paracord instance
            </h1>
          </header>

          {/* These messages are instructions, not labels: they must wrap rather
              than ellipsize, or the operator is told something went wrong and
              not what to do about it. */}
          {statusError && <ErrorBanner multiline message={statusError} />}
          {rulesMismatch && <ErrorBanner multiline message={rulesMismatch} />}
          <div
            ref={errorRef}
            tabIndex={-1}
            aria-live="assertive"
            className="outline-none empty:hidden"
          >
            {error && <ErrorBanner multiline message={error} />}
          </div>

          {step.id === 'token' && (
            <AuthStep
              key="token"
              progress={progress}
              title="Enter your setup code"
              description="This makes you the owner. When your server started it printed a setup link — opening that link fills this in for you. Otherwise paste the long code from the end of that link, or from first-owner-claim.txt next to the server’s config file. Nobody can create an account here until it has been used."
            >
              <AuthScroll>
                <Field
                  label="Setup code"
                  required
                  error={errorFor('token')}
                  hint="Paste it exactly as printed — it is used once and then stops working."
                  descriptionId={tokenHintId}
                >
                  <Input
                    type="text"
                    value={draft.token}
                    onChange={(e) => edit('token', e.target.value)}
                    required
                    className="pc-mono"
                    placeholder="A1B2C3…"
                    autoComplete="off"
                    spellCheck={false}
                    error={Boolean(errorFor('token'))}
                    aria-invalid={Boolean(errorFor('token')) || undefined}
                    aria-describedby={tokenHintId}
                  />
                </Field>
              </AuthScroll>
            </AuthStep>
          )}

          {step.id === 'owner' && (
            <AuthStep
              key="owner"
              dense
              progress={progress}
              title="Create the owner account"
              description="This account administers the instance: settings, moderation, backups. It is a normal account too — you can chat with it. Everyone who arrives later signs up normally and joins as a member."
            >
              <AuthScroll paired>
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

                <Field label="Display name" hint="How people see you. You can change it anytime.">
                  <Input
                    type="text"
                    value={draft.displayName}
                    onChange={(e) => edit('displayName', e.target.value)}
                    placeholder="Ada Lovelace"
                  />
                </Field>

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
                    aria-describedby={errorFor('email') || !requireEmail ? emailErrorId : undefined}
                  />
                </Field>
              </AuthScroll>
            </AuthStep>
          )}

          {step.id === 'password' && (
            <AuthStep
              key="password"
              dense
              progress={progress}
              title="Protect the owner account"
              description="This password is the only thing between a stranger and the instance’s administration. Nothing else on this instance can reset it for you."
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
                    (draft.confirmPassword.length > 0 && draft.password !== draft.confirmPassword
                      ? 'These passwords don’t match yet.'
                      : null)
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
                    error={
                      Boolean(errorFor('confirmPassword')) ||
                      (draft.confirmPassword.length > 0 &&
                        draft.password !== draft.confirmPassword)
                    }
                    aria-describedby={
                      errorFor('confirmPassword') || draft.confirmPassword.length > 0
                        ? confirmErrorId
                        : undefined
                    }
                    aria-invalid={
                      Boolean(errorFor('confirmPassword')) ||
                      (draft.confirmPassword.length > 0 &&
                        draft.password !== draft.confirmPassword) ||
                      undefined
                    }
                  />
                </Field>

                {/* One statement of the rules, at the full measure, under both
                    boxes it governs. */}
                <p
                  id={passwordHintId}
                  className="pc-auth-span text-meta leading-relaxed text-text-faint"
                >
                  {PASSWORD_REQUIREMENTS_HINT}
                </p>
              </AuthScroll>
            </AuthStep>
          )}

          {step.id === 'place' && (
            <AuthStep
              key="place"
              dense
              progress={progress}
              title="Name the place"
              description="Two names, and you can change both later. The first is for this whole Paracord — everyone who signs in here sees it. The second is for your first server: the place with channels where people actually talk. It starts with a #general channel and a voice channel."
            >
              <AuthScroll paired>
                <Field
                  label="Instance name"
                  required
                  error={errorFor('instanceName')}
                  hint="For example: Riverside Studio."
                  descriptionId={instanceErrorId}
                >
                  <Input
                    type="text"
                    value={draft.instanceName}
                    onChange={(e) => edit('instanceName', e.target.value)}
                    required
                    maxLength={100}
                    placeholder="Riverside Studio"
                    error={Boolean(errorFor('instanceName'))}
                    aria-invalid={Boolean(errorFor('instanceName')) || undefined}
                    aria-describedby={instanceErrorId}
                  />
                </Field>

                <Field
                  label="First server name"
                  required
                  error={errorFor('spaceName')}
                  hint="For example: The Lounge."
                  descriptionId={spaceErrorId}
                >
                  <Input
                    type="text"
                    value={draft.spaceName}
                    onChange={(e) => edit('spaceName', e.target.value)}
                    required
                    minLength={2}
                    maxLength={100}
                    placeholder="The Lounge"
                    error={Boolean(errorFor('spaceName'))}
                    aria-invalid={Boolean(errorFor('spaceName')) || undefined}
                    aria-describedby={spaceErrorId}
                  />
                </Field>
              </AuthScroll>
            </AuthStep>
          )}

          <div className="flex items-center gap-3">
            {stepIndex > firstStepIndex && (
              <Button type="button" variant="ghost" size="lg" onClick={goBack} disabled={loading}>
                Back
              </Button>
            )}
            <Button
              type="submit"
              size="lg"
              loading={loading}
              disabled={loading}
              className="flex-1"
            >
              {isLastStep ? 'Claim this instance' : 'Continue'}
            </Button>
          </div>

          {stepIndex === 0 && (
            <p className="text-meta leading-relaxed text-text-secondary">
              Joining someone else’s server instead? You don’t need a setup code — ask them for an
              invite link and sign up there.
            </p>
          )}
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}
