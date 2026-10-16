import { useState, useEffect, type ReactNode } from 'react';
import { Copy, Check, RefreshCw } from 'lucide-react';
import { inviteApi, type ShareAddress } from '../../api/invites';
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
import { Select } from '../ui/Input';
import { ErrorBanner } from '../ui/Feedback';
import { extractApiError } from '../../api/client';
import { writeClipboardText } from '../../lib/clipboard';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { ROUTER_SETTING_LABEL } from '../../lib/instanceAccess';
import { NO_PUBLIC_ADDRESS, shareNoteText } from '../../lib/shareAddress';

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

/** A field's label above it: 12.5/600 in the tertiary ink, sentence case (§6.12). */
function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1.5 block text-[12.5px] font-semibold text-[var(--ix-ink-3)]">{children}</span>;
}

/**
 * The readout a person copies from: the field fill and a hairline (`pc-well`),
 * the Copy control inside it. While changed options are waiting to be applied
 * it dims, and the copy control beside it is disabled, so nobody hands out a
 * link that is about to be revoked.
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
        'pc-well flex h-11 items-center gap-2 py-1 pl-3 pr-1',
        'transition-opacity duration-[40ms] ease-[var(--ix-ease)]',
        // Keyed on the field, not `focus-within`: this well also holds Copy,
        // which draws its own ring. One ring per control.
        'has-[>input:focus-visible]:[outline:var(--ix-focus)] has-[>input:focus-visible]:[outline-offset:var(--ix-focus-offset)]',
        dimmed && 'opacity-60',
      )}
    >
      {children}
    </div>
  );
}

/**
 * A button's label that crossfades to its done word and back (§5.16, 60ms; the
 * parent holds `done` for 2s). Both words sit in one grid cell so the button
 * keeps the width of the longer one and nothing around it moves.
 */
function CopyLabel({ done, idle, copied, size }: { done: boolean; idle: string; copied: string; size: number }) {
  return (
    <span className="ix-copy">
      <span data-on={!done}>
        <Copy size={size} aria-hidden /> {idle}
      </span>
      <span data-on={done} aria-hidden>
        <Check size={size} aria-hidden /> {copied}
      </span>
    </span>
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
 * An invite is for people somewhere else, so the link is always a public
 * address: the one this person already uses when it is public (a domain or a
 * public IP), else the one the server says it is reachable as. A home-network
 * or loopback address reaches nobody an invite is for, so it is never the
 * link; with no public address known there is no link, and the note says why.
 */
export async function resolveShareAddress(): Promise<ShareAddress> {
  const own = ownServerBaseUrl();
  if (!isLoopbackOrigin(own) && !isPrivateNetworkOrigin(own)) return { url: own, reach: 'unknown' };
  try {
    const { data } = await inviteApi.shareAddress();
    if (data?.url && !isLoopbackOrigin(data.url) && !isPrivateNetworkOrigin(data.url)) return data;
    if (data?.reach === 'this_computer') return { url: null, reach: 'this_computer' };
    return { url: null, reach: 'unknown', asks_router: data?.asks_router, note: data?.note, port: data?.port };
  } catch {
    // An older server has no such endpoint, so it cannot say what its public address is.
    return { url: null, reach: 'unknown' };
  }
}

/**
 * Who a link will work for, and — when it only works at home — the one thing
 * that changes that. A server that was installed home-only is pointed at the
 * setting that opens it up; one whose router said no is pointed at the router.
 */
export function reachNote(share: Pick<ShareAddress, 'reach' | 'asks_router' | 'note' | 'port' | 'url'>): string {
  const asksRouter = share.asks_router;
  switch (share.reach) {
    case 'internet_unconfirmed':
      return (
        shareNoteText(share) ??
        'People outside your network may not reach this until the server’s port is forwarded on the router.'
      );
    case 'this_computer':
      return 'This server can only be reached from this computer right now, so nobody else can use an invite yet. It needs to be started so that other computers can reach it.';
    default: {
      if (share.url) return 'Send this to a friend. It opens in any browser, and the Paracord app accepts it too.';
      const blocked = shareNoteText(share);
      const setting =
        asksRouter === false
          ? ` The owner can also turn on “${ROUTER_SETTING_LABEL}” in Admin → Settings, or set the server's public address.`
          : '';
      return `${NO_PUBLIC_ADDRESS}${blocked ? ` ${blocked}` : ''}${setting}`;
    }
  }
}

export function InviteModal({ guildName, channelId, onClose }: InviteModalProps) {
  const [copiedPortable, setCopiedPortable] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [expiration, setExpiration] = useState('7days');
  const [maxUses, setMaxUses] = useState('25');
  const [inviteCode, setInviteCode] = useState('');
  const [portableLink, setPortableLink] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [share, setShare] = useState<ShareAddress>({ url: null, reach: 'unknown' });
  const [loading, setLoading] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // True once the user has changed an option away from the currently-minted invite,
  // signaling that a regenerate is needed to apply it.
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
      const resolved = await resolveShareAddress();
      setInviteCode(code);
      setShare(resolved);
      setInviteLink(resolved.url ? `${resolved.url}/invite/${code}` : '');
      setPortableLink(resolved.url ? toPortableUri(resolved.url, code) : '');
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
      setTimeout(() => setCopiedCode(false), 2000);
    } catch (err) {
      setCopyError(`Failed to copy invite code: ${extractApiError(err)}`);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      labeledBy="invite-modal-title"
      describedBy="invite-modal-description"
      showCloseButton
      size="sm"
    >
      <div className="flex max-h-[min(86dvh,40rem)] flex-col">
        <ModalHeader className="pr-14">
          <ModalTitle id="invite-modal-title">Invite people to {guildName}</ModalTitle>
          <ModalDescription id="invite-modal-description">
            Share a link or code. Anyone with it can join.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="min-h-0 flex-1 space-y-4 overflow-auto pb-4 pt-2">
          {inviteError && <ErrorBanner message={inviteError} multiline />}
          {copyError && <ErrorBanner message={copyError} multiline />}

          {/* The invite link — the one cream action in this dialog. An ordinary
              https link, because that is what works for a friend who has never
              heard of Paracord: it opens in their browser. */}
          <div>
            <FieldLabel>Invite link</FieldLabel>
            <InviteReadout dimmed={optionsDirty}>
              <input
                type="text"
                value={loading ? 'Generating…' : inviteLink || 'No link that other people can use yet'}
                readOnly
                aria-label="Invite link"
                title={inviteLink || undefined}
                className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--ix-ink)] outline-none"
              />
              <Button
                variant="primary"
                size="sm"
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
                <CopyLabel done={copiedPortable} idle="Copy link" copied="Link copied" size={14} />
              </Button>
            </InviteReadout>
            <p
              className="mt-2 text-[12.5px] leading-[1.45] text-[var(--ix-ink-3)]"
              data-testid="invite-reach-note"
              data-reach={share.reach}
            >
              {reachNote(share)}
            </p>
            {portableLink && !optionsDirty && (
              <button
                type="button"
                onClick={handleCopyAppLink}
                className="pc-focusable mt-1.5 block rounded-[6px] text-left text-[12.5px] font-medium text-[var(--ix-ink-2)] underline-offset-2 hover:text-[var(--ix-ink)] hover:underline"
              >
                Friend already has the Paracord app? Copy a link that opens it directly
              </button>
            )}
          </div>

          {/* The raw invite code — an id you read out loud. */}
          <div>
            <FieldLabel>Invite code</FieldLabel>
            <InviteReadout dimmed={optionsDirty}>
              <input
                type="text"
                value={loading ? 'Generating…' : inviteCode}
                readOnly
                aria-label="Invite code"
                className="pc-mono min-w-0 flex-1 bg-transparent text-[14px] text-[var(--ix-ink-2)] outline-none"
              />
              <Button
                variant="glass"
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
                <CopyLabel done={copiedCode} idle="Copy code" copied="Code copied" size={13} />
              </Button>
            </InviteReadout>
          </div>

          {/* Options */}
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
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
        <ModalFooter className="items-center justify-between gap-3 pt-2">
          <p className="min-w-0 flex-1 text-[12.5px] leading-[1.4] text-[var(--ix-ink-3)]">
            {optionsDirty
              ? 'Options changed. Regenerate to apply them to a fresh link.'
              : 'Regenerating revokes the current link and issues a new one.'}
          </p>
          <Button
            variant="ghost"
            onClick={handleRegenerate}
            disabled={loading}
            className="shrink-0 gap-2"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
            {loading ? 'Regenerating…' : 'Regenerate'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
