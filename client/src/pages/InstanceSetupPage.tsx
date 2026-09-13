import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { AuthCanvas, AuthCard, AuthHeading, AppMark, Field } from './authScaffold';
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
    return `This server enforces different password rules than this page describes: ${requirements.min_length}–${requirements.max_length} ${requirements.length_unit === 'utf8_bytes' ? 'bytes' : 'characters'}, uppercase ${requirements.requires_uppercase ? 'required' : 'not required'}, lowercase ${requirements.requires_lowercase ? 'required' : 'not required'}, digit ${requirements.requires_digit ? 'required' : 'not required'}, symbol ${requirements.requires_symbol ? 'required' : 'not required'}. Follow the server's rules.`;
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
  const status = (err as { response?: { status?: number } })?.response?.status;
  const message = extractApiError(err);
  if (status === 401 || message === 'unauthorized') {
    return 'That claim token is not the one this server printed. Copy it again from the server’s terminal or from first-owner-claim.txt — it is case-sensitive, and whitespace counts.';
  }
  return message || 'Setup failed. Check the claim token and try again.';
}

/**
 * Numbered section, so the four things being asked for read as steps.
 *
 * A well inside the page's one plate (spec §4): depth is the inset shadow, not
 * a border. The step number is quiet mono meta, not a filled circle — a badge
 * that loud would outrank the thing it counts.
 */
function Step({
  index,
  title,
  description,
  children,
}: {
  index: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pc-well flex flex-col gap-4 p-4 sm:p-5">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span aria-hidden="true" className="pc-mono text-meta text-text-faint">
            {index}
          </span>
          <h2 className="pc-display text-heading text-text-primary">{title}</h2>
        </div>
        <p className="mt-1.5 text-meta leading-relaxed text-text-secondary">{description}</p>
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}

/**
 * The first-owner claim. An unclaimed server has no accounts at all, so this is
 * the only page on it that can create one — and it needs the one-time token the
 * server printed in its own terminal, which is what proves the person filling
 * this in is the person running the machine.
 */
export function InstanceSetupPage() {
  const tokenHintId = useId();
  const passwordHintId = useId();
  const confirmErrorId = useId();
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [requirements, setRequirements] = useState<PasswordRequirements | null>(null);
  const [requireEmail, setRequireEmail] = useState(false);

  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [spaceName, setSpaceName] = useState('');

  const [error, setError] = useState('');
  // Bumped on every rejection so an identical repeat still re-announces.
  const [errorSeq, setErrorSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  // This form is taller than any viewport, and the submit button is at the
  // bottom: a banner rendered at the top is a rejection the operator never
  // sees, which reads as "the button does nothing". Bring it into view and
  // move focus to it so it is announced as well as visible.
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
            'Could not reach this server to check whether it has been set up. Check that it is running and reload.',
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

  const trimmedEmail = email.trim();
  const emailError =
    trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)
      ? 'That doesn’t look like an email address.'
      : null;
  const confirmError =
    confirmPassword.length > 0 && password !== confirmPassword
      ? 'These passwords don’t match yet.'
      : null;
  const rulesMismatch = passwordRulesMismatch(requirements);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedToken = token.trim();
    const trimmedUsername = username.trim();
    const trimmedInstanceName = instanceName.trim();
    const trimmedSpaceName = spaceName.trim();

    if (!trimmedToken) {
      rejectWith('Paste the claim token from your server’s terminal to continue.');
      return;
    }
    if (!trimmedUsername) {
      rejectWith('Choose a username for the owner account.');
      return;
    }
    const passwordError = registrationPasswordError(password);
    if (passwordError) {
      rejectWith(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      rejectWith('Passwords do not match.');
      return;
    }
    if (!trimmedInstanceName) {
      rejectWith('Give this server a name so people know where they are.');
      return;
    }
    if (trimmedSpaceName.length < 2) {
      rejectWith('Name the first space — at least 2 characters.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      const { data } = await instanceApi.claimInstance({
        token: trimmedToken,
        username: trimmedUsername,
        email: trimmedEmail || undefined,
        password,
        instance_name: trimmedInstanceName,
        initial_space_name: trimmedSpaceName,
        display_name: displayName.trim() || undefined,
      });
      setAccessToken(data.token);
      setRefreshToken(data.refresh_token ?? null);
      useAuthStore.setState({ token: data.token, user: data.user as User });
      await useAuthStore.getState().fetchUser();
      navigate(`/app/guilds/${data.space.id}`, { replace: true });
    } catch (err: unknown) {
      rejectWith(claimFailureMessage(err));
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <AuthCanvas>
        <AuthCard className="max-w-md">
          <div className="p-7 sm:p-8">
            <AppMark size={40} />
            <p className="mt-6 text-body text-text-secondary">Checking this server…</p>
          </div>
        </AuthCard>
      </AuthCanvas>
    );
  }

  return (
    <AuthCanvas>
      <AuthCard className="max-w-xl">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6 p-7 sm:p-8">
          <AuthHeading
            title="Set up your Paracord server"
            subtitle="You’re setting up the server itself, not joining one. This creates the owner account — the person who runs this machine — names the server and opens its first space. Everyone who arrives later signs up normally and joins as a member."
          />

          {/* These messages are instructions, not labels: they must wrap rather
              than ellipsize, or the operator is told something went wrong and
              not what to do about it. */}
          {statusError && <ErrorBanner multiline message={statusError} />}
          {rulesMismatch && <ErrorBanner multiline message={rulesMismatch} />}
          <div ref={errorRef} tabIndex={-1} aria-live="assertive" className="outline-none">
            {error && <ErrorBanner multiline message={error} />}
          </div>

          <Step
            index={1}
            title="Prove you run this server"
            description="Your server printed a one-time claim token when it started. It is also saved as first-owner-claim.txt next to the server's config file, readable only by the account that runs it. Nobody can create an account here until this token is used."
          >
            <Field
              label="Claim token"
              required
              hint="Paste it exactly as printed — it is used once and then stops working."
              descriptionId={tokenHintId}
            >
              <Input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                className="pc-mono"
                placeholder="A1B2C3…"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={tokenHintId}
              />
            </Field>
          </Step>

          <Step
            index={2}
            title="Create the owner account"
            description="This account administers the server: settings, moderation, backups. It is a normal account too — you can chat with it."
          >
            <Field label="Username" required hint="Your unique @handle on this server.">
              <Input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                placeholder="ada"
                autoComplete="username"
              />
            </Field>

            <Field label="Display name" hint="How people see you. You can change it anytime.">
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Ada Lovelace"
              />
            </Field>

            <Field
              label="Email"
              required={requireEmail}
              error={emailError}
              hint={requireEmail ? undefined : 'Optional — used only for password recovery.'}
            >
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required={requireEmail}
                placeholder={requireEmail ? 'you@example.com' : 'you@example.com (optional)'}
                autoComplete="email"
              />
            </Field>

            <Field
              label="Password"
              required
              hint={PASSWORD_REQUIREMENTS_HINT}
              descriptionId={passwordHintId}
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Choose a strong password"
                autoComplete="new-password"
                aria-describedby={passwordHintId}
              />
            </Field>

            <Field
              label="Confirm password"
              required
              error={confirmError}
              descriptionId={confirmErrorId}
            >
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                placeholder="Re-enter your password"
                autoComplete="new-password"
                aria-describedby={confirmError ? confirmErrorId : undefined}
                aria-invalid={Boolean(confirmError) || undefined}
              />
            </Field>
          </Step>

          <Step
            index={3}
            title="Name this server"
            description="Shown to everyone who signs in here, so it should say whose community this is."
          >
            <Field label="Server name" required hint="For example: Riverside Studio.">
              <Input
                type="text"
                value={instanceName}
                onChange={(e) => setInstanceName(e.target.value)}
                required
                maxLength={100}
                placeholder="Riverside Studio"
              />
            </Field>
          </Step>

          <Step
            index={4}
            title="Open the first space"
            description="A space is where conversations live. This one is created with a #general channel and a voice room; you can add more later."
          >
            <Field label="First space name" required hint="For example: The Lounge.">
              <Input
                type="text"
                value={spaceName}
                onChange={(e) => setSpaceName(e.target.value)}
                required
                minLength={2}
                maxLength={100}
                placeholder="The Lounge"
              />
            </Field>
          </Step>

          <Button type="submit" size="lg" loading={loading} disabled={loading} className="w-full">
            Claim this server
          </Button>

          <p className="text-meta leading-relaxed text-text-secondary">
            Joining someone else’s community instead? You don’t need a claim token — ask them for an
            invite link and sign up there as a member.
          </p>
        </form>
      </AuthCard>
    </AuthCanvas>
  );
}
