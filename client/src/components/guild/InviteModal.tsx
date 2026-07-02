import { useState, useEffect, useRef } from 'react';
import { X, Copy, Check, Link, RefreshCw } from 'lucide-react';
import { createPortal } from 'react-dom';
import { inviteApi } from '../../api/invites';
import { getStoredServerUrl } from '../../lib/apiBaseUrl';
import { toPortableUri } from '../../lib/portableLinks';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { extractApiError } from '../../api/client';
import { writeClipboardText } from '../../lib/clipboard';

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
  const dialogRef = useRef<HTMLDivElement>(null);
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

  useFocusTrap(dialogRef, true, onClose);

  const handleCopyPortable = async () => {
    try {
      setCopyError(null);
      await writeClipboardText(portableLink);
      setCopiedPortable(true);
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
      setTimeout(() => setCopiedCode(false), 2000);
    } catch (err) {
      setCopyError(`Failed to copy invite code: ${extractApiError(err)}`);
    }
  };

  const modal = (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-modal-title"
        tabIndex={-1}
        className="glass-modal modal-content max-h-[min(86dvh,42rem)] w-[min(92vw,32rem)] overflow-auto rounded-2xl border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative px-8 pb-5 pt-8 sm:px-8 sm:pt-8">
          <button onClick={onClose} className="icon-btn absolute right-3 top-3 sm:right-5 sm:top-5" aria-label="Close">
            <X size={20} />
          </button>
          <h2 id="invite-modal-title" className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            Invite friends to {guildName}
          </h2>
        </div>

        {/* Body */}
        <div className="space-y-7 px-8 pb-8 sm:px-8 sm:pb-8">
          {inviteError && (
            <div
              role="alert"
              className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger"
            >
              {inviteError}
            </div>
          )}

          {copyError && (
            <div
              role="alert"
              className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger"
            >
              {copyError}
            </div>
          )}

          {/* Portable invite link (primary) */}
          <div>
            <label className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              <Link size={12} />
              Portable invite link
            </label>
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Share this link with anyone -- it works from any device, even on a different network.
            </p>
            <div
              className="mt-3 flex items-center overflow-hidden rounded-xl"
              style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
            >
              <input
                type="text"
                value={loading ? 'Generating...' : portableLink}
                readOnly
                className="flex-1 bg-transparent px-4 py-3 text-[15px] outline-none"
                style={{ color: 'var(--text-primary)' }}
              />
              <button
                onClick={handleCopyPortable}
                disabled={loading || !portableLink}
                aria-label={copiedPortable ? 'Portable invite link copied' : 'Copy portable invite link'}
                className="inline-flex items-center justify-center px-4 py-3 text-sm font-semibold text-white transition-colors"
                style={{ backgroundColor: copiedPortable ? 'var(--accent-success)' : 'var(--accent-primary)' }}
              >
                {copiedPortable ? (
                  <span className="flex items-center gap-1"><Check size={14} /> Copied!</span>
                ) : (
                  <span className="flex items-center gap-1"><Copy size={14} /> Copy</span>
                )}
              </button>
            </div>
          </div>

          {/* Raw invite code (secondary) */}
          <div>
            <label className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Invite code
            </label>
            <div
              className="mt-3 flex items-center overflow-hidden rounded-xl"
              style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
            >
              <input
                type="text"
                value={loading ? 'Generating...' : inviteCode}
                readOnly
                className="flex-1 bg-transparent px-4 py-2.5 font-mono text-[14px] outline-none"
                style={{ color: 'var(--text-muted)' }}
              />
              <button
                onClick={handleCopyCode}
                disabled={loading || !inviteCode}
                aria-label={copiedCode ? 'Invite code copied' : 'Copy invite code'}
                className="inline-flex items-center justify-center px-3 py-2.5 text-xs font-semibold transition-colors"
                style={{ color: copiedCode ? 'var(--accent-success)' : 'var(--text-secondary)' }}
              >
                {copiedCode ? (
                  <span className="flex items-center gap-1"><Check size={12} /> Copied</span>
                ) : (
                  <span className="flex items-center gap-1"><Copy size={12} /> Copy</span>
                )}
              </button>
            </div>
          </div>

          {/* Settings */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <label className="flex-1">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                Expire After
              </span>
              <select
                value={expiration}
                onChange={(e) => {
                  setExpiration(e.target.value);
                  setOptionsDirty(true);
                }}
                className="select-field mt-3"
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
            <label className="flex-1">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                Max Uses
              </span>
              <select
                value={maxUses}
                onChange={(e) => {
                  setMaxUses(e.target.value);
                  setOptionsDirty(true);
                }}
                className="select-field mt-3"
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

          {/* Regenerate action -- option changes only take effect when applied here. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {optionsDirty
                ? 'Options changed -- regenerate to apply them to a fresh link.'
                : 'Regenerating revokes the current link and issues a new one.'}
            </p>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={loading}
              className="btn-ghost gap-2 border border-[color:var(--border-subtle)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
              {loading ? 'Regenerating...' : 'Regenerate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
