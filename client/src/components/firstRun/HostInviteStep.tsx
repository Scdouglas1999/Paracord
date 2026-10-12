import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';

import { writeClipboardText } from '../../lib/clipboard';
import { CordMark } from '../brand/CordMark';
import { BackButton, FrGlyph, GoButton } from './primitives';
import { Screen, type ScreenState } from './Screen';

export const EXPIRY_CHOICES = [
  { seconds: 3600, label: '1 hour' },
  { seconds: 86_400, label: '1 day' },
  { seconds: 604_800, label: '7 days' },
] as const;
export const USE_CHOICES = [1, 5, 10, 25, 100] as const;

export interface HostInviteView {
  /** `{share_url}/invite/{code}`; null while it is being made. */
  url: string | null;
  /** The address only reaches the home network (§1.13 amber note). */
  lan: boolean;
  /** Only this computer can reach the server right now (§5.5 `this_computer`). */
  onlyHere: boolean;
  /** The public address changed while the server ran (§5.6). */
  addressChanged: boolean;
  maxAge: number;
  maxUses: number;
  error: string | null;
}

/** The invite link as a QR code (error correction H, so the mark in the middle does not break it). */
function QrCode({ text }: { text: string }) {
  const path = useMemo(() => {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
    const size = qr.modules.size;
    let d = '';
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (qr.modules.get(y, x)) d += `M${x} ${y}h1v1h-1z`;
      }
    }
    return { d, size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${path.size} ${path.size}`} shapeRendering="crispEdges" role="img" aria-label="QR code of the invite link">
      <path d={path.d} fill="currentColor" />
    </svg>
  );
}

function OptionMenu<T extends number>({
  label,
  value,
  choices,
  render,
  onPick,
}: {
  label: string;
  value: T;
  choices: readonly T[];
  render: (v: T) => string;
  onPick: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) {
        if (e instanceof KeyboardEvent) e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close, true);
    };
  }, [open]);
  return (
    <span ref={ref} style={{ marginLeft: 'auto', position: 'relative' }}>
      <button type="button" className="fr-opts__change" aria-haspopup="menu" aria-expanded={open} aria-label={`Change ${label}`} onClick={() => setOpen((v) => !v)}>
        Change
      </button>
      {open && (
        <span className="fr-opts__menu" role="menu" aria-label={label}>
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={choice === value}
              onClick={() => {
                setOpen(false);
                if (choice !== value) onPick(choice);
              }}
            >
              {render(choice)}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

const expiryLabel = (s: number) => EXPIRY_CHOICES.find((c) => c.seconds === s)?.label ?? `${Math.round(s / 3600)} hours`;

/**
 * Host › Invite (docs/setup-spec.md §1.13): the link and its QR code, ready the
 * moment setup is done. The link follows the server's share address (§5.6);
 * changing an option revokes the old invite and makes a new one.
 */
export function HostInviteStep({
  state,
  serverName,
  view,
  busy,
  onChange,
  onContinue,
  onBack,
}: {
  state: ScreenState;
  serverName: string;
  view: HostInviteView;
  busy: boolean;
  onChange: (options: { maxAge: number; maxUses: number }) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Screen
      step="invite"
      state={state}
      title="Invite your friends"
      sub={
        <>
          Anyone with this link can join <b>{serverName}</b>. It opens in Paracord, or in any browser.
        </>
      }
      onSubmit={() => !busy && onContinue()}
      footer={
        <>
          <BackButton onClick={onBack} />
          <GoButton disabled={busy} data-testid="fr-open-server">
            Open {serverName}
          </GoButton>
        </>
      }
    >
      <div className="fr-linkrow" data-testid="fr-invite-link">
        <code>{view.url ?? 'Making your link…'}</code>
        <button
          type="button"
          className="fr-chip fr-chip--cream"
          data-copied={copied ? '' : undefined}
          disabled={!view.url}
          onClick={async () => {
            if (!view.url) return;
            await writeClipboardText(view.url);
            setCopied(true);
          }}
        >
          <FrGlyph name={copied ? 'check' : 'copy'} size={15} />
          <span aria-live="polite">{copied ? 'Copied' : 'Copy link'}</span>
        </button>
      </div>
      {view.error && (
        <div className="fr-fielderr" role="alert">
          {view.error}
        </div>
      )}
      {view.addressChanged && (
        <div className="fr-lanwarn" role="status">
          <FrGlyph name="warn" size={15} />
          Your public address changed. Links you shared before won&rsquo;t work; share this one.
        </div>
      )}
      {view.onlyHere && (
        <div className="fr-lanwarn" data-testid="fr-only-here-note">
          <FrGlyph name="warn" size={15} />
          Only this computer can reach this server right now, so nobody else can use this link yet.
        </div>
      )}
      {view.lan && (
        <div className="fr-lanwarn" data-testid="fr-lan-note">
          <FrGlyph name="warn" size={15} />
          Works on your home network until your router lets friends in. Paracord keeps trying.
        </div>
      )}
      <div className="fr-share">
        <div className="fr-qr">
          {view.url && <QrCode text={view.url} />}
          <span className="fr-qr__mark">
            <CordMark size={28} />
          </span>
        </div>
        <div className="fr-opts">
          <div>
            <FrGlyph name="clock" size={16} />
            Expires in {expiryLabel(view.maxAge)}
            <OptionMenu
              label="when the link expires"
              value={view.maxAge}
              choices={EXPIRY_CHOICES.map((c) => c.seconds)}
              render={expiryLabel}
              onPick={(maxAge) => onChange({ maxAge, maxUses: view.maxUses })}
            />
          </div>
          <div>
            <FrGlyph name="people" size={16} />
            Up to {view.maxUses} {view.maxUses === 1 ? 'person' : 'people'}
            <OptionMenu
              label="how many people can use the link"
              value={view.maxUses}
              choices={USE_CHOICES}
              render={(n) => `${n} ${n === 1 ? 'person' : 'people'}`}
              onPick={(maxUses) => onChange({ maxAge: view.maxAge, maxUses })}
            />
          </div>
          <div>
            <FrGlyph name="phone" size={16} />
            Scan with a phone to join there
          </div>
          <div className="fr-opts__quiet">You can find this link again under Invite.</div>
        </div>
      </div>
    </Screen>
  );
}
