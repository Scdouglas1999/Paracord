import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useAuthenticatedImage } from '../../../lib/authenticatedImage';
import { getIdentityColor } from '../../../lib/colors';
import { displayName } from '../../../lib/displayName';
import { presenceLabel } from '../../../lib/presence';
import { resolveUserAvatarUrl } from '../../../lib/userAvatar';
import { useAuthStore } from '../../../stores/authStore';
import { Tooltip } from '../../ui/Tooltip';
import { toggleHeaderSheet, useHeaderSheetOpen } from './sheetBridge';

/** Up to two letters for the face when there is no picture. Never an emoji. */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toUpperCase() || '?';
}

/**
 * Your face at the pane's right edge, with a presence dot (docs/glass-spec.md
 * §3.2). It opens the account menu (WP-G18).
 *
 * Presence is not a color (plan §1.3 / §7): online is a solid dot in the
 * ink, away a ring, do not disturb a dot with a bar, invisible and offline a
 * faint ring. The state is also in the button's accessible name.
 */
export function HeaderAvatar() {
  const user = useCurrentUser();
  const status = useAuthStore((s) => s.settings?.status) ?? 'online';
  const accountOpen = useHeaderSheetOpen('account');
  useDownloadTicket();
  const src = useAuthenticatedImage(resolveUserAvatarUrl(user?.avatar_hash));

  const name = user ? displayName(user) : 'You';
  const state = status === 'invisible' ? 'Invisible' : presenceLabel(status);
  const label = `Your profile, ${state.toLowerCase()}`;

  return (
    <Tooltip content={label} side="bottom">
      <button
        type="button"
        className="glass-header__avatar glass-focusable"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={accountOpen}
        onClick={() => toggleHeaderSheet('account')}
      >
        <span
          className="glass-header__face"
          style={{ background: src ? undefined : getIdentityColor(user?.id ?? '0') }}
          aria-hidden
        >
          {src ? <img src={src} alt="" draggable={false} /> : initialsOf(name)}
        </span>
        <span className="glass-header__presence" data-status={status} aria-hidden />
      </button>
    </Tooltip>
  );
}
