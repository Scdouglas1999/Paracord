import { useState, useEffect, type ReactNode } from 'react';
import { Copy, Check, RefreshCw } from 'lucide-react';
import { inviteApi } from '../../api/invites';
import { getStoredServerUrl } from '../../lib/config/apiBaseUrl';
import { toPortableUri } from '../../lib/portableLinks';
import {
  Modal,
  ModalBody,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../ui/Modal';
import { Button } from '../ui/Button';
import { Divider } from '../ui/Divider';
import { Select } from '../ui/Input';
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

/**
 * The readout a person copies from: a **well** inside the dialog plate
 * (spec §1.1, §4) — recessed, depth from the inset shadow, never a border.
 * While changed options are waiting to be applied it dims, and the copy control
 * beside it is disabled, so nobody hands out a link that is about to be revoked.
 */
function InviteReadout({
  dimmed,
  children,
}: {
  dimmed: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'pc-well flex items-center gap-2 p-1.5 pl-3',
        'transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'focus-within:shadow-[var(--shadow-well),var(--focus-ring)]',
        dimmed && 'opacity-60',
      )}
    >
      {children}
    </div>
  );
}

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
      describedBy="invite-modal-description"
      showCloseButton
      panelClassName="w-[min(92vw,32rem)]"
    >
      <div className="flex max-h-[min(86dvh,42rem)] flex-col">
        <ModalHeader className="pb-4 pr-14">
          <ModalTitle id="invite-modal-title">Invite friends to {guildName}</ModalTitle>
          <ModalDescription id="invite-modal-description">
            Share a link or code — anyone with it can join the conversation.
          </ModalDescription>
        </ModalHeader>
        <Divider />

        <ModalBody className="min-h-0 flex-1 space-y-6 overflow-auto py-5">
          {inviteError && <ErrorBanner message={inviteError} multiline />}
          {copyError && <ErrorBanner message={copyError} multiline />}

          {/* Portable invite link — the one primary action in this dialog. */}
          <div>
            <FieldLabel>Portable invite link</FieldLabel>
            <InviteReadout dimmed={optionsDirty}>
              <input
                type="text"
                value={loading ? 'Generating…' : portableLink}
                readOnly
                aria-label="Portable invite link"
                className="min-w-0 flex-1 bg-transparent text-label text-text-primary outline-none"
              />
              <Button
                variant="primary"
                onClick={handleCopyPortable}
                disabled={loading || !portableLink || optionsDirty}
                aria-label={
                  copiedPortable
                    ? 'Portable invite link copied'
                    : optionsDirty
                      ? 'Copy portable invite link (apply changed options first)'
                      : 'Copy portable invite link'
                }
              >
                {copiedPortable ? (
                  <><Check size={15} /> Copied</>
                ) : (
                  <><Copy size={15} /> Copy</>
                )}
              </Button>
            </InviteReadout>
            <p className="mt-1.5 text-meta leading-relaxed text-text-muted">
              Works from any device, even on a different network.
            </p>
          </div>

          {/* Raw invite code — mono, because it is an id you read out loud. */}
          <div>
            <FieldLabel>Invite code</FieldLabel>
            <InviteReadout dimmed={optionsDirty}>
              <input
                type="text"
                value={loading ? 'Generating…' : inviteCode}
                readOnly
                aria-label="Invite code"
                className="pc-mono min-w-0 flex-1 bg-transparent text-label text-text-secondary outline-none"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyCode}
                disabled={loading || !inviteCode || optionsDirty}
                aria-label={
                  copiedCode
                    ? 'Invite code copied'
                    : optionsDirty
                      ? 'Copy invite code (apply changed options first)'
                      : 'Copy invite code'
                }
              >
                {copiedCode ? (
                  <><Check size={13} /> Copied</>
                ) : (
                  <><Copy size={13} /> Copy</>
                )}
              </Button>
            </InviteReadout>
          </div>

          {/* Options */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <FieldLabel>Expire After</FieldLabel>
              <Select
                value={expiration}
                onChange={(e) => {
                  setExpiration(e.target.value);
                  setOptionsDirty(true);
                }}
              >
                <option value="30min">30 minutes</option>
                <option value="1hr">1 hour</option>
                <option value="6hr">6 hours</option>
                <option value="12hr">12 hours</option>
                <option value="1day">1 day</option>
                <option value="7days">7 days</option>
                <option value="never">Never</option>
              </Select>
            </label>
            <label className="block">
              <FieldLabel>Max Uses</FieldLabel>
              <Select
                value={maxUses}
                onChange={(e) => {
                  setMaxUses(e.target.value);
                  setOptionsDirty(true);
                }}
              >
                <option value="1">1 use</option>
                <option value="5">5 uses</option>
                <option value="10">10 uses</option>
                <option value="25">25 uses</option>
                <option value="50">50 uses</option>
                <option value="100">100 uses</option>
                <option value="unlimited">No limit</option>
              </Select>
            </label>
          </div>
        </ModalBody>

        {/* Regenerate — option changes only take effect when applied here. */}
        <Divider />
        <ModalFooter className="flex-col items-stretch gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-meta leading-relaxed text-text-muted">
            {optionsDirty
              ? 'Options changed — regenerate to apply them to a fresh link.'
              : 'Regenerating revokes the current link and issues a new one.'}
          </p>
          <Button
            variant="ghost"
            onClick={handleRegenerate}
            disabled={loading}
            className="shrink-0 gap-2 self-end sm:self-auto"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
            {loading ? 'Regenerating…' : 'Regenerate'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
