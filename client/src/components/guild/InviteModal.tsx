import { useState, useEffect } from 'react';
import { Copy, Check, Link as LinkIcon, RefreshCw } from 'lucide-react';
import { inviteApi } from '../../api/invites';
import { getStoredServerUrl } from '../../lib/config/apiBaseUrl';
import { toPortableUri } from '../../lib/portableLinks';
import { Modal, ModalTitle } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/Feedback';
import { FieldLabel } from './SettingsPrimitives';
import { extractApiError } from '../../api/client';
import { writeClipboardText } from '../../lib/clipboard';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';

interface InviteModalProps {
  guildName: string;
  channelId: string;
  onClose: () => void;
}

const EXPIRATION_MAP: Record<string, number | undefined> = {
  '30min': 1800,
  '1hr': 3600,
  '6hr': 21600,
  '12hr': 43200,
  '1day': 86400,
  '7days': 604800,
  'never': 0,
};

const MAX_USES_MAP: Record<string, number | undefined> = {
  '1': 1, '5': 5, '10': 10, '25': 25, '50': 50, '100': 100,
  'unlimited': 0,
};

/** Resolve the server's base URL for encoding into portable links. */
function resolveServerBaseUrl(): string {
  const stored = getStoredServerUrl();
  if (stored) return stored.replace(/\/+$/, '');
  return window.location.origin;
}

export function InviteModal({ guildName, channelId, onClose }: InviteModalProps) {
  const [copiedPortable, setCopiedPortable] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [expiration, setExpiration] = useState('7days');
  const [maxUses, setMaxUses] = useState('unlimited');
  const [inviteCode, setInviteCode] = useState('');
  const [portableLink, setPortableLink] = useState('');
  const [loading, setLoading] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // True once the user has changed an option away from the currently-minted invite,
  // signalling that a regenerate is needed to apply it.
  const [optionsDirty, setOptionsDirty] = useState(false);

  /**
   * Mint an invite for the current options. When `previousCode` is supplied (a
   * regenerate), the prior invite is revoked afterwards so toggling options can
   * never leave orphaned, still-usable invites behind.
   */
  const generateInvite = async (previousCode?: string) => {
    setLoading(true);
    setInviteError(null);
    setCopyError(null);
    try {
      const { data } = await inviteApi.create(channelId, {
        max_age: EXPIRATION_MAP[expiration],
        max_uses: MAX_USES_MAP[maxUses],
      });
      const code = data.code;
      const serverUrl = resolveServerBaseUrl();
      setInviteCode(code);
      setPortableLink(toPortableUri(serverUrl, code));
      setOptionsDirty(false);
      // Best-effort cleanup of the invite this one replaces. The new invite is
      // already live, so a failed revoke should not surface as a user error.
      if (previousCode && previousCode !== code) {
        try {
          await inviteApi.delete(previousCode);
        } catch {
          /* ignore: the replacement invite is already active */
        }
      }
    } catch (err) {
      // Preserve the existing invite on a failed regenerate; only clear on the
      // initial generation where there is nothing usable to fall back to.
      if (!previousCode) {
        setInviteCode('');
        setPortableLink('');
      }
      setInviteError(`Failed to generate invite: ${extractApiError(err)}`);
    } finally {
      setLoading(false);
    }
  };

  // Generate a single invite when the modal opens (or the channel changes).
  // Option changes intentionally do NOT auto-regenerate; the user applies them
  // via the explicit Regenerate action below.
  useEffect(() => {
    void generateInvite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const handleRegenerate = () => {
    void generateInvite(inviteCode || undefined);
  };

  const handleCopyPortable = async () => {
    try {
      setCopyError(null);
      await writeClipboardText(portableLink);
      setCopiedPortable(true);
      toast.success('Invite link copied to clipboard.');
      setTimeout(() => setCopiedPortable(false), 2000);
    } catch (err) {
      setCopyError(`Failed to copy portable invite link: ${extractApiError(err)}`);
    }
  };

  const handleCopyCode = async () => {
    try {
      setCopyError(null);
      await writeClipboardText(inviteCode);
      setCopiedCode(true);
      toast.success('Invite code copied to clipboard.');
      setTimeout(() => setCopiedCode(false), 2000);
    } catch (err) {
      setCopyError(`Failed to copy invite code: ${extractApiError(err)}`);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="invite-modal-title"
      showCloseButton
      panelClassName="w-[min(92vw,32rem)]"
    >
      <div className="max-h-[min(86dvh,42rem)] overflow-auto">
        {/* Header */}
        <div className="border-b border-border-subtle px-6 pb-5 pt-6 pr-14">
          <ModalTitle id="invite-modal-title">Invite friends to {guildName}</ModalTitle>
          <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
            Share a link or code — anyone with it can join the conversation.
          </p>
        </div>

        {/* Body */}
        <div className="space-y-6 px-6 py-5">
          {inviteError && <ErrorBanner message={inviteError} />}
          {copyError && <ErrorBanner message={copyError} />}

          {/* Portable invite link (primary) */}
          <div>
            <FieldLabel className="flex items-center gap-1.5">
              <LinkIcon size={13} className="text-text-muted" />
              Portable invite link
            </FieldLabel>
            <div
              className={cn(
                'flex items-stretch overflow-hidden rounded-sm border border-border-subtle bg-bg-tertiary transition-opacity',
                optionsDirty && 'opacity-60',
              )}
            >
              <input
                type="text"
                value={loading ? 'Generating…' : portableLink}
                readOnly
                className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-sm text-text-primary outline-none"
              />
              <button
                onClick={handleCopyPortable}
                disabled={loading || !portableLink || optionsDirty}
                aria-label={
                  copiedPortable
                    ? 'Portable invite link copied'
                    : optionsDirty
                      ? 'Copy portable invite link (apply changed options first)'
                      : 'Copy portable invite link'
                }
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 px-4 text-label font-semibold text-text-on-accent outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60',
                  copiedPortable ? 'bg-accent-success' : 'bg-accent-primary hover:bg-accent-primary-hover active:bg-accent-primary-active',
                )}
              >
                {copiedPortable ? (
                  <><Check size={15} /> Copied</>
                ) : (
                  <><Copy size={15} /> Copy</>
                )}
              </button>
            </div>
            <p className="mt-1.5 text-meta leading-relaxed text-text-muted">
              Works from any device, even on a different network.
            </p>
          </div>

          {/* Raw invite code (secondary) */}
          <div>
            <FieldLabel>Invite code</FieldLabel>
            <div
              className={cn(
                'flex items-stretch overflow-hidden rounded-sm border border-border-subtle bg-bg-tertiary transition-opacity',
                optionsDirty && 'opacity-60',
              )}
            >
              <input
                type="text"
                value={loading ? 'Generating…' : inviteCode}
                readOnly
                className="min-w-0 flex-1 bg-transparent px-3.5 py-2 font-code text-sm text-text-secondary outline-none"
              />
              <button
                onClick={handleCopyCode}
                disabled={loading || !inviteCode || optionsDirty}
                aria-label={
                  copiedCode
                    ? 'Invite code copied'
                    : optionsDirty
                      ? 'Copy invite code (apply changed options first)'
                      : 'Copy invite code'
                }
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 px-3.5 text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] hover:bg-bg-mod-subtle disabled:cursor-not-allowed disabled:opacity-60',
                  copiedCode ? 'text-accent-success' : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {copiedCode ? (
                  <><Check size={13} /> Copied</>
                ) : (
                  <><Copy size={13} /> Copy</>
                )}
              </button>
            </div>
          </div>

          {/* Options */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <FieldLabel>Expire After</FieldLabel>
              <select
                value={expiration}
                onChange={(e) => {
                  setExpiration(e.target.value);
                  setOptionsDirty(true);
                }}
                className="select-field"
              >
                <option value="30min">30 minutes</option>
                <option value="1hr">1 hour</option>
                <option value="6hr">6 hours</option>
                <option value="12hr">12 hours</option>
                <option value="1day">1 day</option>
                <option value="7days">7 days</option>
                <option value="never">Never</option>
              </select>
            </label>
            <label className="block">
              <FieldLabel>Max Uses</FieldLabel>
              <select
                value={maxUses}
                onChange={(e) => {
                  setMaxUses(e.target.value);
                  setOptionsDirty(true);
                }}
                className="select-field"
              >
                <option value="1">1 use</option>
                <option value="5">5 uses</option>
                <option value="10">10 uses</option>
                <option value="25">25 uses</option>
                <option value="50">50 uses</option>
                <option value="100">100 uses</option>
                <option value="unlimited">No limit</option>
              </select>
            </label>
          </div>

          {/* Regenerate — option changes only take effect when applied here. */}
          <div className="flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-meta leading-relaxed text-text-muted">
              {optionsDirty
                ? 'Options changed — regenerate to apply them to a fresh link.'
                : 'Regenerating revokes the current link and issues a new one.'}
            </p>
            <Button
              variant="secondary"
              onClick={handleRegenerate}
              disabled={loading}
              className="shrink-0 gap-2"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
              {loading ? 'Regenerating…' : 'Regenerate'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
