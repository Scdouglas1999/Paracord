import { useState, useEffect, type ReactNode } from 'react';
import { Copy, Check, RefreshCw } from 'lucide-react';
import { inviteApi, type ShareAddress, type ShareReach } from '../../api/invites';
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
import { ROUTER_SETTING_LABEL } from '../../lib/instanceAccess';

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
        // Keyed on the field, not `focus-within`: this well also holds Copy,
        // which draws its own ring. §9 is one ring per control.
        'has-[>input:focus-visible]:shadow-[var(--shadow-well),var(--focus-ring)]',
        dimmed && 'opacity-60',
      )}
    >
      {children}
    </div>
  );
}

/** The address this person reaches the server by. */
function ownServerBaseUrl(): string {
  const stored = getStoredServerUrl();
  if (stored) return stored.replace(/\/+$/, '');
  return window.location.origin;
}

/**
 * A private (RFC 1918) or link-local IPv4 address: a link built on one only
 * works for people on the same network, whatever the server says.
 */
export function isPrivateNetworkOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    const [a, b] = parts;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.endsWith('.localhost') || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * What an invite should point at, and how far it will carry.
 *
 * The address somebody is using works for other people too — unless it is
 * `localhost`, which is exactly the owner who set the server up on the machine
 * it runs on, and whose links used to send every friend to the friend's own
 * computer. Then, and only then, the server is asked what it is reachable as.
 */
export async function resolveShareAddress(): Promise<ShareAddress> {
  const own = ownServerBaseUrl();
  const loopback = isLoopbackOrigin(own);
  // An address on the home network is no use to a friend elsewhere either, so
  // ask the server whether it has a better one (its router-mapped address).
  const lan = !loopback && isPrivateNetworkOrigin(own);
  if (!loopback && !lan) return { url: own, reach: 'unknown' };
  try {
    const { data } = await inviteApi.shareAddress();
    if (data?.url && !isLoopbackOrigin(data.url)) {
      if (lan && data.reach !== 'internet') {
        return { url: own, reach: 'local_network', asks_router: data.asks_router };
      }
      return { url: data.url, reach: data.reach, asks_router: data.asks_router };
    }
    if (lan) return { url: own, reach: 'local_network', asks_router: data?.asks_router };
  } catch {
    // An older server has no such endpoint. The note below says what that means.
    if (lan) return { url: own, reach: 'local_network' };
  }
  return { url: null, reach: 'this_computer' };
}

/**
 * Who a link will work for, and — when it only works at home — the one thing
 * that changes that. A server that was installed home-only is pointed at the
 * setting that opens it up; one whose router said no is pointed at the router.
 */
export function reachNote(reach: ShareReach, asksRouter?: boolean): string {
  switch (reach) {
    case 'local_network':
      if (asksRouter === false) {
        return `Right now this only works for people on the same network (the same Wi-Fi) as the server: it is set up to be reachable on your home network only. To let friends elsewhere join, whoever runs the server can turn on “${ROUTER_SETTING_LABEL}” in Admin → Settings and restart it.`;
      }
      return 'Right now this only works for people on the same network (the same Wi-Fi) as the server. For friends elsewhere, the router needs a port opened: see “Friends outside your network” in the Paracord docs.';
    case 'this_computer':
      return 'This server can only be reached from this computer right now, so nobody else can use an invite yet. It needs to be started so that other computers can reach it.';
    default:
      return 'Send this to a friend. It opens in any browser, and the Paracord app accepts it too.';
  }
}

export function InviteModal({ guildName, channelId, onClose }: InviteModalProps) {
  const [copiedPortable, setCopiedPortable] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [expiration, setExpiration] = useState('7days');
  const [maxUses, setMaxUses] = useState('unlimited');
  const [inviteCode, setInviteCode] = useState('');
  const [portableLink, setPortableLink] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [reach, setReach] = useState<ShareReach>('unknown');
  const [asksRouter, setAsksRouter] = useState<boolean | undefined>(undefined);
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
      const share = await resolveShareAddress();
      setInviteCode(code);
      setReach(share.reach);
      setAsksRouter(share.asks_router);
      setInviteLink(share.url ? `${share.url}/invite/${code}` : '');
      setPortableLink(share.url ? toPortableUri(share.url, code) : '');
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
        setInviteLink('');
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
      await writeClipboardText(inviteLink);
      setCopiedPortable(true);
      toast.success('Invite link copied to clipboard.');
      setTimeout(() => setCopiedPortable(false), 2000);
    } catch (err) {
      setCopyError(`Failed to copy the invite link: ${extractApiError(err)}`);
    }
  };

  /** `paracord://…` — opens straight in the desktop app, for a friend who has it. */
  const handleCopyAppLink = async () => {
    try {
      setCopyError(null);
      await writeClipboardText(portableLink);
      toast.success('App link copied to clipboard.');
    } catch (err) {
      setCopyError(`Failed to copy the app link: ${extractApiError(err)}`);
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

          {/* The invite link — the one primary action in this dialog. An
              ordinary https link, because that is what works for a friend who
              has never heard of Paracord: it opens in their browser. */}
          <div>
            <FieldLabel>Invite link</FieldLabel>
            <InviteReadout dimmed={optionsDirty}>
              <input
                type="text"
                value={loading ? 'Generating…' : inviteLink || 'No link that other people can use yet'}
                readOnly
                aria-label="Invite link"
                className="min-w-0 flex-1 bg-transparent text-label text-text-primary outline-none"
              />
              <Button
                variant="primary"
                onClick={handleCopyPortable}
                disabled={loading || !inviteLink || optionsDirty}
                aria-label={
                  copiedPortable
                    ? 'Invite link copied'
                    : optionsDirty
                      ? 'Copy invite link (apply changed options first)'
                      : 'Copy invite link'
                }
              >
                {copiedPortable ? (
                  <><Check size={15} /> Copied</>
                ) : (
                  <><Copy size={15} /> Copy</>
                )}
              </Button>
            </InviteReadout>
            <p className="mt-1.5 text-meta leading-relaxed text-text-muted">{reachNote(reach, asksRouter)}</p>
            {portableLink && !optionsDirty && (
              <button
                type="button"
                onClick={handleCopyAppLink}
                className="pc-focusable mt-1 rounded-chip text-meta font-medium text-text-link hover:underline"
              >
                Friend already has the Paracord app? Copy a link that opens it directly
              </button>
            )}
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
              <FieldLabel>Expire after</FieldLabel>
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
              <FieldLabel>Max uses</FieldLabel>
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
