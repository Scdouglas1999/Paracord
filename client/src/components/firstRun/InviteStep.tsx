import { useId, type ReactNode } from 'react';

import type { InvitePreview } from '../../api/generated/InvitePreview';
import { formatTrustWords } from '../../lib/trustWords';
import { useFirstRunStore, type InviteCheck } from '../../stores/firstRunStore';
import { CordSpinner } from '../brand/CordMark';
import { Avatar } from '../ix/identity/Avatar';
import { ServerMark } from '../ix/identity/ServerMark';
import { plural } from './preview/model';
import { BackButton, Chip, FrGlyph, GoButton, OnlineLine } from './primitives';
import { Screen, type ScreenState } from './Screen';

/** What a server is called in a sentence: its name, else its address. */
export function serverLabel(check: InviteCheck): string {
  return check.preview?.guild?.name || check.preview?.instance?.name || check.host || 'This server';
}

/** The server card (§1.5): mark, name, who is there, up to three faces. */
export function ServerCard({ preview, children }: { preview: InvitePreview; children?: ReactNode }) {
  const guild = preview.guild!;
  const faces = (preview.faces ?? []).slice(0, 3);
  const online = guild.online_count ?? 0;
  return (
    <div className="fr-srv" data-testid="fr-server-card">
      <div className="fr-srv__hd">
        <ServerMark guildId={guild.id} name={guild.name} hue={guild.hue ?? null} size={48} />
        <div>
          <b>{guild.name}</b>
          <OnlineLine>
            {online.toLocaleString('en-US')} online · {plural(guild.member_count, 'member')}
          </OnlineLine>
        </div>
        {faces.length > 0 && (
          <span className="fr-faces" aria-label={`${faces.length} of the people there`}>
            {faces.map((face, i) => (
              <Avatar key={i} userId={`face-${i}`} name={face.initial} hue={face.hue} size={26} />
            ))}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** The trust row (§1.5, §7.3): the four words for a self-signed server, or the CA line, or on the web the page's own host. */
export function TrustRow({ host, words, caVerified, web, bare = false }: { host: string; words: string[]; caVerified: boolean; web: boolean; bare?: boolean }) {
  return (
    <div className={bare ? 'fr-trust fr-trust--bare' : 'fr-trust'} data-testid="fr-trust-row">
      <FrGlyph name="shield" size={16} />
      {web ? (
        <span>
          <b>You&rsquo;re on {host}.</b>
        </span>
      ) : caVerified ? (
        <span>
          <b>Connected securely to {host}.</b> Its certificate is issued by a public certificate authority.
        </span>
      ) : (
        <span>
          <b>Connected securely to {host}.</b> We remembered this server&rsquo;s identity and will warn you if it ever changes.
          {words.length > 0 && (
            <span className="fr-trust__words" data-testid="fr-trust-words">
              {formatTrustWords(words)}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Join › Invite (docs/setup-spec.md §1.5): paste the link, see the server and
 * who is there, and its identity, before anything is created. On a server's
 * own web page the invite is already resolved and read-only (§6.6).
 */
export function InviteStep({
  state,
  web,
  busy,
  continueError,
  onTextChange,
  onUseClipboard,
  onRetry,
  onContinue,
  onBack,
  onOpenApp,
}: {
  state: ScreenState;
  web: boolean;
  /** Continue is trusting the server. */
  busy: boolean;
  continueError: string | null;
  onTextChange: (text: string) => void;
  onUseClipboard: () => void;
  onRetry: () => void;
  onContinue: () => void;
  onBack?: () => void;
  /** Web: open the invite in the desktop app (`paracord://`). */
  onOpenApp?: () => void;
}) {
  const text = useFirstRunStore((s) => s.inviteText);
  const check = useFirstRunStore((s) => s.invite);
  const clipboard = useFirstRunStore((s) => s.clipboardInvite);
  const fieldId = useId();
  const errId = useId();

  const label = serverLabel(check);
  const showBanner = !web && clipboard && check.state !== 'card';
  const canContinue = check.state === 'card' && !busy;
  const fieldError =
    check.state === 'invalid'
      ? "This invite doesn't work anymore. Ask for a new link."
      : check.state === 'old-server'
        ? `${label} runs an older version of Paracord. Ask the person who runs it to update, then try again.`
        : check.state === 'not-a-link'
          ? 'Paste the whole link, like https://friend.example/invite/AbC123.'
          : null;

  return (
    <Screen
      step="invite"
      state={state}
      title="Paste your invite"
      sub={web ? 'You were invited to this server.' : 'Ask the friend who runs the server for a link.'}
      onSubmit={() => canContinue && onContinue()}
      footer={
        <>
          {onBack && <BackButton onClick={onBack} />}
          <GoButton disabled={!canContinue} data-testid="fr-invite-continue">
            Continue
          </GoButton>
        </>
      }
    >
      {showBanner && (
        <div className="fr-found" data-testid="fr-clipboard-banner">
          <FrGlyph name="clipboard" size={16} />
          There&rsquo;s an invite on your clipboard.
          <Chip onClick={onUseClipboard}>Use it</Chip>
        </div>
      )}
      <div className="fr-fl">
        <input
          id={fieldId}
          className="fr-inp"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="https://…/invite/…"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={web}
          aria-label="Invite link"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError || check.state === 'unreachable' ? errId : undefined}
          data-testid="fr-invite-field"
        />
      </div>
      {check.state === 'checking' && (
        <div className="fr-checking" role="status" data-testid="fr-invite-checking">
          <CordSpinner size={18} />
          Checking the invite…
        </div>
      )}
      {fieldError && (
        <div className="fr-fielderr" id={errId} role="alert" data-testid="fr-invite-error">
          {fieldError}
        </div>
      )}
      {check.state === 'unreachable' && (
        <div className="fr-fielderr" id={errId} role="alert" data-testid="fr-invite-error">
          Can&rsquo;t reach {check.host}. Check the link, or ask your friend whether their server is running.
          <Chip onClick={onRetry}>Try again</Chip>
        </div>
      )}
      {check.state === 'identity-changed' && (
        <div className="fr-fielderr fr-fielderr--quiet" role="status">
          {label} has a new identity. Paracord won&rsquo;t connect to it until you review it.
          <Chip onClick={onRetry}>Review</Chip>
        </div>
      )}
      {check.state === 'card' && check.preview && (
        <ServerCard preview={check.preview}>
          <TrustRow host={check.host ?? ''} words={check.identity?.words ?? []} caVerified={check.identity?.caVerified ?? false} web={web} />
        </ServerCard>
      )}
      {continueError && (
        <div className="fr-fielderr" role="alert">
          {continueError}
        </div>
      )}
      {web && onOpenApp && (
        <button type="button" className="fr-secondary-link fr-openapp" onClick={onOpenApp}>
          Open in the Paracord app
        </button>
      )}
    </Screen>
  );
}
