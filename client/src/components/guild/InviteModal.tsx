import { useState, useEffect } from 'react';
import { X, Copy, Check, Link } from 'lucide-react';
import { createPortal } from 'react-dom';
import { inviteApi } from '../../api/invites';
import { getStoredServerUrl } from '../../lib/apiBaseUrl';
import { toPortableUri } from '../../lib/portableLinks';

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
  'never': undefined,
};

const MAX_USES_MAP: Record<string, number | undefined> = {
  '1': 1, '5': 5, '10': 10, '25': 25, '50': 50, '100': 100,
  'unlimited': undefined,
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

  const generateInvite = async () => {
    setLoading(true);
    try {
      const { data } = await inviteApi.create(channelId, {
        max_age: EXPIRATION_MAP[expiration],
        max_uses: MAX_USES_MAP[maxUses],
      });
      const code = data.code;
      const serverUrl = resolveServerBaseUrl();
      setInviteCode(code);
      setPortableLink(toPortableUri(serverUrl, code));
    } catch {
      setInviteCode('');
      setPortableLink('Failed to generate invite');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    generateInvite();
  }, [channelId, expiration, maxUses]);

  const handleCopyPortable = async () => {
    await navigator.clipboard?.writeText(portableLink);
    setCopiedPortable(true);
    setTimeout(() => setCopiedPortable(false), 2000);
  };

  const handleCopyCode = async () => {
    await navigator.clipboard?.writeText(inviteCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const modal = (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}
    >
      <div
        className="glass-modal modal-content w-[min(92vw,32rem)] overflow-hidden rounded-2xl border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative px-7 pt-7 pb-3">
          <button onClick={onClose} className="icon-btn absolute right-5 top-5">
            <X size={20} />
          </button>
          <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            Invite friends to {guildName}
          </h2>
        </div>

        {/* Body */}
        <div className="px-7 pb-7">
          {/* Portable invite link (primary) */}
          <div className="mt-3">
            <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              <Link size={12} />
              Portable invite link
            </label>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Share this link with anyone -- it works from any device, even on a different network.
            </p>
            <div
              className="mt-2.5 flex items-center overflow-hidden rounded-xl"
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
          <div className="mt-4">
            <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Invite code
            </label>
            <div
              className="mt-2 flex items-center overflow-hidden rounded-xl"
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
          <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <label className="flex-1">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                Expire After
              </span>
              <select
                value={expiration}
                onChange={(e) => setExpiration(e.target.value)}
                className="select-field mt-2"
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
                onChange={(e) => setMaxUses(e.target.value)}
                className="select-field mt-2"
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
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
