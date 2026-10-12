import type { CSSProperties } from 'react';

import type { HostPreflight } from '../../api/generated/HostPreflight';
import { HOST_HUES, useFirstRunStore } from '../../stores/firstRunStore';
import { BackButton, Chip, Field, FrGlyph, GoButton } from './primitives';
import { Screen, type ScreenState } from './Screen';

/** Why this computer cannot host, in the words of spec §2.3. */
export function preflightRefusal(preflight: HostPreflight): string | null {
  if (preflight.ok) return null;
  switch (preflight.reason) {
    case 'no_user_services':
      return "Hosting from this computer needs systemd user services, which this system doesn't run. You can still host with the server installer: paracord.chat/docs/host.";
    case 'no_keychain':
      return "Paracord keeps the key that encrypts your server in your system keychain, and this computer doesn't have one running. Install or turn on GNOME Keyring or KWallet, then try again.";
    case 'existing_server':
      return 'Paracord is already running on this computer.';
    case 'no_port':
      return 'Every port Paracord could use (8443 to 8463) is taken.';
    case 'no_space':
      return 'This computer needs at least 1 GB free to host a server.';
    default:
      return preflight.detail || 'This computer cannot host a server.';
  }
}

const HUE_NAMES: Record<number, string> = {
  18: 'Ember',
  350: 'Rose',
  38: 'Amber',
  150: 'Green',
  172: 'Teal',
  200: 'Blue',
  220: 'Indigo',
  0: 'Red',
};

/**
 * Host › Name (docs/setup-spec.md §1.4): the server's name and color. The
 * preview follows every keystroke. When this computer cannot host, a notice
 * replaces the fields and Continue stays off (§2.3).
 */
export function NameStep({
  state,
  checkHost,
  onContinue,
  onBack,
  onUseExisting,
  onRetryPreflight,
}: {
  state: ScreenState;
  /** The desktop host path checks this computer; claim mode does not. */
  checkHost: boolean;
  onContinue: () => void;
  onBack?: () => void;
  onUseExisting: (url: string) => void;
  onRetryPreflight: () => void;
}) {
  const name = useFirstRunStore((s) => s.serverName);
  const hue = useFirstRunStore((s) => s.hue);
  const preflight = useFirstRunStore((s) => s.preflight);
  const setServerName = useFirstRunStore((s) => s.setServerName);
  const setHue = useFirstRunStore((s) => s.setHue);

  const refusal = checkHost && preflight.status === 'done' && preflight.result ? preflightRefusal(preflight.result) : null;
  const failed = checkHost && preflight.status === 'error';
  const blocked = Boolean(refusal) || failed;
  const ready = !checkHost || (preflight.status === 'done' && preflight.result?.ok === true);
  const canContinue = ready && !blocked && name.trim().length >= 2;

  return (
    <Screen
      step="name"
      state={state}
      title="What should we call your server?"
      sub="This is the name your friends will see. You can change it any time."
      onSubmit={() => canContinue && onContinue()}
      footer={
        <>
          {onBack && <BackButton onClick={onBack} />}
          <GoButton disabled={!canContinue}>Continue</GoButton>
          {checkHost && preflight.status === 'checking' && name.trim().length >= 2 && <span className="fr-foot__hint">Checking this computer…</span>}
        </>
      }
    >
      {blocked ? (
        <div className="fr-block" role="alert" data-testid="fr-preflight-block" data-reason={preflight.result?.reason ?? 'error'}>
          <FrGlyph name="warn" size={18} />
          <div>
            {failed ? `Paracord couldn't check whether this computer can host (${preflight.error}).` : refusal}
            <div>
              {preflight.result?.reason === 'existing_server' && preflight.result.existing_url ? (
                <Chip variant="cream" onClick={() => onUseExisting(preflight.result!.existing_url!)}>
                  Use it
                </Chip>
              ) : (
                (failed || preflight.result?.reason === 'no_keychain' || preflight.result?.reason === 'no_port' || preflight.result?.reason === 'no_space') && (
                  <Chip onClick={onRetryPreflight}>Try again</Chip>
                )
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          <Field>
            <input
              className="fr-inp fr-inp--big"
              value={name}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="Friday Night Crew"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              aria-label="Server name"
              data-testid="fr-server-name"
            />
          </Field>
          <div className="fr-fl">
            <span className="fr-label" id="fr-color-label">
              Color
            </span>
            <div className="fr-hues" role="radiogroup" aria-labelledby="fr-color-label">
              {HOST_HUES.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={h === hue}
                  aria-label={HUE_NAMES[h] ?? `Hue ${h}`}
                  style={{ '--h': h } as CSSProperties}
                  onClick={() => setHue(h)}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </Screen>
  );
}
