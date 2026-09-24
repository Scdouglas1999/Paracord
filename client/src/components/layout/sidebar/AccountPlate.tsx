import { useEffect, useRef, useState } from 'react';
import { Check, Headphones, Mic, Settings, Shield } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { Divider, IconButton, MenuItem, MenuLabel, Plate, Popover } from '../../ui';
import { LitAvatar } from '../../light';
import { displayName } from '../../../lib/displayName';
import { personLight } from '../../../lib/attention/light';
import { presenceLight } from '../../../lib/presence';
import { publishPresence } from '../../../lib/presenceActivities';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';
import { toast } from '../../../stores/toastStore';
import { writeClipboardText } from '../../../lib/clipboard';
import type { UserSettings } from '../../../types';

/**
 * AccountPlate — "sam.douglas · Online", pinned to the bottom of the
 * Buildings column (docs/lantern-stage-spec.md §7.1, §8).
 *
 * It replaces `components/layout/UserPanel.tsx` and keeps everything that panel
 * could do: the status picker, a custom status, copy-username, the microphone
 * and headphone toggles, the admin entry and user settings. What changes is
 * where they live — the plate shows your light and your name, and the rest is
 * one menu behind it, because §1.5 says presence is light and §7.1 draws this
 * surface as a plate with a single settings control.
 */

export type PresenceStatus = UserSettings['status'];

/**
 * §1.5: a picker is the one place that legitimately needs a per-option visual,
 * so each option carries a swatch in the light vocabulary, not a color.
 */
const STATUS_OPTIONS: Array<{ id: PresenceStatus; label: string; swatch: string }> = [
  { id: 'online', label: 'Online', swatch: 'pc-lit' },
  { id: 'idle', label: 'Away', swatch: 'pc-dim' },
  { id: 'dnd', label: 'Do not disturb', swatch: 'pc-dim pc-dnd' },
  { id: 'invisible', label: 'Invisible', swatch: 'pc-dim' },
];

const INVISIBLE_LABEL = 'Invisible';

export interface AccountPlateProps {
  user: { id: string; username: string; display_name?: string | null; avatar_hash?: string | null; flags?: number } | null;
  navigate: (path: string) => void;
  muted: boolean;
  deafened: boolean;
  onToggleMute: () => void;
  onToggleDeaf: () => void;
  showAdminDashboard: boolean;
}

/**
 * "Online" / "Away · muted" — the plate's second line, always in words (§9).
 * Invisible is what you chose, so the plate says so: everyone else sees you
 * as offline, and you should not have to guess which one you are.
 */
export function accountCaption(
  status: PresenceStatus | undefined,
  custom: string | null | undefined,
  muted: boolean,
  deafened: boolean,
): string {
  const base = custom?.trim()
    ? custom.trim()
    : status === 'invisible'
      ? INVISIBLE_LABEL
      : presenceLight(status).label;
  if (deafened) return `${base} · deafened`;
  if (muted) return `${base} · muted`;
  return base;
}

export function AccountPlate({
  user,
  navigate,
  muted,
  deafened,
  onToggleMute,
  onToggleDeaf,
  showAdminDashboard,
}: AccountPlateProps) {
  const settings = useAuthStore((s) => s.settings);
  const updateSettings = useAuthStore((s) => s.updateSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState(settings?.custom_status ?? '');
  const anchorRef = useRef<HTMLButtonElement>(null);

  const status = settings?.status ?? 'online';
  const customStatus = settings?.custom_status ?? null;
  const userFlags = Number(user?.flags ?? 0);
  const canOpenAdminDashboard =
    showAdminDashboard || (Number.isFinite(userFlags) && (userFlags & 1) !== 0);

  useEffect(() => {
    setCustomDraft(settings?.custom_status ?? '');
  }, [settings?.custom_status]);

  const name = displayName(user);
  const caption = accountCaption(status, customStatus, muted, deafened);
  const person = personLight({
    userId: user?.id ?? '0',
    name,
    status: status === 'invisible' ? 'offline' : status,
    avatar: user?.avatar_hash ?? null,
  });

  const copyUsername = () => {
    void writeClipboardText(user?.username || '')
      .then(() => toast.success('Username copied.'))
      .catch((err) =>
        toast.error(`Failed to copy username: ${err instanceof Error ? err.message : String(err)}`),
      );
  };

  const applyStatus = async (next: PresenceStatus, custom?: string | null) => {
    try {
      await updateSettings({
        status: next,
        custom_status: custom === undefined ? (settings?.custom_status ?? null) : custom,
      } as Partial<UserSettings>);
      // The saved settings now carry the new status and custom status; send
      // them with whatever activities are on (listening, playing …).
      publishPresence();
    } catch (err) {
      toast.error(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <Plate bare className="flex items-center gap-2.5 rounded-[var(--radius-card)] px-2.5 py-2">
      <button
        ref={anchorRef}
        type="button"
        aria-label={`${name} — ${caption}. Open account menu`}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={() => setMenuOpen((open) => !open)}
        onContextMenu={(event) => {
          event.preventDefault();
          copyUsername();
        }}
        className="pc-focusable flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-control)] text-left"
      >
        <LitAvatar person={person} size={32} hideLabel />
        <span className="flex min-w-0 flex-col">
          <span className="pc-display truncate text-name font-semibold text-text-primary">{name}</span>
          <span className="truncate text-meta text-text-faint">{caption}</span>
        </span>
      </button>

      <IconButton
        label="Open user settings"
        size="sm"
        onClick={() => useUIStore.getState().setUserSettingsOpen(true)}
      >
        <Settings size={16} aria-hidden />
      </IconButton>

      <Popover
        anchor={anchorRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        side="top"
        align="start"
        role="menu"
        label="Account"
        className="w-60"
      >
        <MenuLabel>Status</MenuLabel>
        {STATUS_OPTIONS.map((option) => (
          <MenuItem
            key={option.id}
            role="menuitemradio"
            aria-checked={status === option.id}
            icon={<span aria-hidden className={cn('h-2.5 w-2.5 rounded-full bg-bg-raised', option.swatch)} />}
            trailing={status === option.id ? <Check size={14} aria-hidden /> : undefined}
            onClick={() => {
              void applyStatus(option.id);
              setMenuOpen(false);
            }}
          >
            {option.label}
          </MenuItem>
        ))}

        <Divider className="my-1" />

        <MenuItem
          role="menuitemcheckbox"
          aria-checked={muted}
          icon={<Mic size={16} aria-hidden />}
          trailing={muted ? 'off' : 'on'}
          onClick={() => {
            onToggleMute();
            setMenuOpen(false);
          }}
        >
          Microphone
        </MenuItem>
        <MenuItem
          role="menuitemcheckbox"
          aria-checked={deafened}
          icon={<Headphones size={16} aria-hidden />}
          trailing={deafened ? 'off' : 'on'}
          onClick={() => {
            onToggleDeaf();
            setMenuOpen(false);
          }}
        >
          Headphones
        </MenuItem>

        <Divider className="my-1" />

        <MenuItem
          onClick={() => {
            copyUsername();
            setMenuOpen(false);
          }}
        >
          Copy username
        </MenuItem>
        {canOpenAdminDashboard && (
          <MenuItem
            icon={<Shield size={16} aria-hidden />}
            onClick={() => {
              navigate('/app/admin');
              setMenuOpen(false);
            }}
          >
            Admin dashboard
          </MenuItem>
        )}

        <MenuLabel>Custom status</MenuLabel>
        <div className="flex gap-1.5 px-1.5 pb-1.5">
          <input
            id="account-plate-custom-status"
            aria-label="Custom status"
            className="pc-well min-w-0 flex-1 px-2.5 py-1 text-meta text-text-primary outline-none focus-visible:shadow-[var(--shadow-well),var(--focus-ring)] placeholder:text-text-faint"
            value={customDraft}
            maxLength={128}
            placeholder="What's up?"
            onChange={(event) => setCustomDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void applyStatus(status, customDraft.trim() || null);
              setMenuOpen(false);
            }}
          />
          <IconButton
            label="Set custom status"
            size="sm"
            tone="raised"
            onClick={() => {
              void applyStatus(status, customDraft.trim() || null);
              setMenuOpen(false);
            }}
          >
            <Check size={14} aria-hidden />
          </IconButton>
        </div>
      </Popover>
    </Plate>
  );
}
