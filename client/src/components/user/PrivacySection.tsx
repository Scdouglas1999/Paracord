import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button, ToggleRow } from '../ui';
import { usePrivacySettings } from '../../hooks/usePrivacySettings';
import { ProtectedSheet, type ProtectedHostRows } from '../firstRun/ProtectedSheet';

export interface PrivacySectionProps {
  /**
   * "Ask for my password when Paracord opens": on a one-password account a
   * choice of this computer (`lib/askForPassword.ts`), on an older server the
   * account's `crypto_auth_enabled`. This is the switch only; the owner passes
   * the state and the handler.
   */
  askForPassword: {
    on: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
    note?: string;
    /** A choice of this computer only (one-password accounts): says so under the row. */
    perDevice?: boolean;
  };
  /** Host rows for the "What's protected" sheet, when this account runs the server. */
  host?: ProtectedHostRows;
}

/**
 * Settings › Privacy (setup spec §8.2): the account's privacy switches, each
 * applying the moment it is flipped, and the "What's protected" sheet shared
 * with the first run.
 */
export function PrivacySection({ askForPassword, host }: PrivacySectionProps) {
  const privacy = usePrivacySettings();
  const [sheetOpen, setSheetOpen] = useState(false);

  const previewsOff = privacy.linkPreviewsServerOff;
  const previewsNote = previewsOff
    ? 'Turned off on this server.'
    : privacy.loaded && !privacy.linkPreviewsSupported
      ? 'This server has not been updated to support it yet.'
      : null;

  return (
    <section data-testid="privacy-section">
      <div className="divide-y divide-border-subtle">
        <ToggleRow
          label="Link previews"
          description="The server fetches them, so websites never see your address. With this off you also stop seeing previews."
          checked={privacy.linkPreviews && !previewsOff}
          onChange={(next) => void privacy.setLinkPreviews(next)}
          disabled={
            !privacy.loaded
            || !privacy.linkPreviewsSupported
            || previewsOff
            || privacy.busy.linkPreviews !== undefined
          }
        >
          {previewsNote && <p className="mt-1.5 text-meta text-text-secondary">{previewsNote}</p>}
          {privacy.errors.linkPreviews && (
            <p role="alert" className="mt-1.5 text-meta text-[var(--ix-danger-ink)]">
              {privacy.errors.linkPreviews}
            </p>
          )}
        </ToggleRow>
        <ToggleRow
          label="Show what I'm playing"
          description="Off until you turn it on. When it is on, the game or app you're using shows in your presence."
          checked={privacy.activity}
          onChange={(next) => void privacy.setActivity(next)}
          disabled={!privacy.loaded || privacy.busy.activity !== undefined}
        >
          {privacy.errors.activity && (
            <p role="alert" className="mt-1.5 text-meta text-[var(--ix-danger-ink)]">
              {privacy.errors.activity}
            </p>
          )}
        </ToggleRow>
        <ToggleRow
          label="Ask for my password when Paracord opens"
          description="Paracord stays locked on this device until you enter your password."
          checked={askForPassword.on}
          onChange={askForPassword.onChange}
          disabled={askForPassword.disabled}
        >
          {askForPassword.perDevice && (
            <p className="mt-1.5 text-meta text-text-secondary" data-testid="privacy-ask-per-device">
              Only on this computer.
            </p>
          )}
          {askForPassword.note && (
            <p className="mt-1.5 text-meta text-text-secondary">{askForPassword.note}</p>
          )}
        </ToggleRow>
      </div>

      <div className="mt-4">
        <Button variant="secondary" onClick={() => setSheetOpen(true)}>
          <ShieldCheck size={16} aria-hidden />
          What&rsquo;s protected
        </Button>
      </div>
      <ProtectedSheet open={sheetOpen} onClose={() => setSheetOpen(false)} host={host} zIndexClassName="z-[160]" />
    </section>
  );
}
