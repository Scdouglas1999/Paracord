import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Clock, Code2, Copy, LogOut, Settings, Shield } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { presenceLabel } from '../../../lib/presence';
import { displayName } from '../../../lib/displayName';
import { writeClipboardText } from '../../../lib/clipboard';
import { publishPresence } from '../../../lib/presenceActivities';
import { useAuthStore } from '../../../stores/authStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { isAdmin, type UserSettings } from '../../../types';
import { Divider, MenuItem, MenuLabel, Popover } from '../../ui';
import { Face } from '../places/Lead';
import { closeSheets, openReminders, restoreSheetTrigger } from './sheetStore';

/**
 * The account menu (docs/glass-spec.md §3.2: "your avatar (with presence dot)
 * at the pane's right edge"; §5: popovers over text are near-solid; WP-G18).
 * Your face in the header opens it: your status and a line of your own, then
 * Reminders, Settings, the admin and developer doors and Sign out.
 *
 * It is a popover, not a sheet: a menu is a control, so it is the near-solid
 * glass (`.pc-floating`, .97 with the heavier blur), anchored under the face.
 * Presence is ink (a dot, a ring, a dot with a bar), never a color.
 */

type Status = 'online' | 'idle' | 'dnd' | 'invisible';

const STATUS_OPTIONS: Array<{ id: Status; label: string }> = [
  { id: 'online', label: 'Online' },
  { id: 'idle', label: 'Away' },
  { id: 'dnd', label: 'Do not disturb' },
  { id: 'invisible', label: 'Invisible' },
];

/** What the header face's anchor is: the button that opened the menu. */
function findAnchor(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>('.glass-header__avatar');
}

export function AccountMenu({ open }: { open: boolean }) {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const settings = useAuthStore((s) => s.settings);
  const updateSettings = useAuthStore((s) => s.updateSettings);
  const menuRef = useRef<HTMLDivElement>(null);
  const [customDraft, setCustomDraft] = useState<string | null>(null);

  // The anchor is looked up when the menu opens: the header face may not exist
  // while it is closed (no conversation on screen).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchor = useMemo(() => ({ current: findAnchor() }), [open]);

  // Focus lands on the status in force when the menu opens, so the arrow keys
  // have a place to start. A frame later: the popover places itself first.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      const first = menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
        ?? menu?.querySelector<HTMLElement>('[role^="menuitem"]');
      first?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const status: Status = (settings?.status as Status | undefined) ?? 'online';
  const customStatus = settings?.custom_status ?? '';
  const draft = customDraft ?? customStatus;
  const name = displayName(user);
  const caption = customStatus.trim() || (status === 'invisible' ? 'Invisible' : presenceLabel(status));
  const canOpenAdmin = Boolean(user && isAdmin(Number(user.flags ?? 0)));

  /** Close the menu. `restore` hands focus back to the face; a choice that opens something else does not. */
  const close = (restore: boolean) => {
    closeSheets();
    setCustomDraft(null);
    // A frame later: the menu is scenery for the beat its exit plays, and focus
    // is only lost once it is.
    if (restore) requestAnimationFrame(() => restoreSheetTrigger('account'));
  };

  const applyStatus = async (next: Status, custom?: string | null) => {
    try {
      await updateSettings({
        status: next,
        custom_status: custom === undefined ? (settings?.custom_status ?? null) : custom,
      } as Partial<UserSettings>);
      // The saved settings carry the new status and custom status; send them
      // with whatever activities are on (listening, playing, ...).
      publishPresence();
    } catch (err) {
      toast.error(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const copyUsername = () => {
    void writeClipboardText(user?.username || '')
      .then(() => toast.success('Username copied.'))
      .catch((err) => toast.error(`Failed to copy username: ${err instanceof Error ? err.message : String(err)}`));
  };

  // Arrow keys move through the rows; Home and End jump. (Escape is the popover's.)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={() => close(true)}
      side="bottom"
      align="end"
      role="menu"
      label="Account"
      className="glass-account w-72"
    >
      <div ref={menuRef} onKeyDown={onKeyDown}>
        <div role="presentation" className="glass-account__who">
          <Face
            face={{ userId: user?.id ?? '0', name, avatar: user?.avatar_hash ?? null }}
            size={40}
          />
          <span className="glass-account__text">
            <span className="glass-account__name">{name}</span>
            <span className="glass-account__caption">{caption}</span>
          </span>
        </div>

        <MenuLabel>Status</MenuLabel>
        {STATUS_OPTIONS.map((option) => (
          <MenuItem
            key={option.id}
            role="menuitemradio"
            aria-checked={status === option.id}
            icon={<span aria-hidden className="glass-sheet-presence glass-sheet-presence--inline" data-status={option.id === 'invisible' ? 'offline' : option.id} />}
            trailing={status === option.id ? <Check size={14} aria-hidden /> : undefined}
            onClick={() => {
              void applyStatus(option.id);
              close(true);
            }}
          >
            {option.label}
          </MenuItem>
        ))}

        <MenuLabel>Custom status</MenuLabel>
        <div className="glass-account__custom">
          <input
            id="account-menu-custom-status"
            aria-label="Custom status"
            className="glass-account__field"
            value={draft}
            maxLength={128}
            placeholder="What's up?"
            onChange={(event) => setCustomDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void applyStatus(status, draft.trim() || null);
              close(true);
            }}
          />
          <button
            type="button"
            className="glass-account__set glass-focusable"
            aria-label="Set custom status"
            onClick={() => {
              void applyStatus(status, draft.trim() || null);
              close(true);
            }}
          >
            <Check size={16} aria-hidden />
          </button>
        </div>

        <Divider className="my-1.5" />

        <MenuItem icon={<Clock size={16} />} onClick={() => openReminders()}>
          Reminders
        </MenuItem>
        <MenuItem
          icon={<Settings size={16} />}
          onClick={() => {
            close(false);
            useUIStore.getState().setUserSettingsOpen(true);
          }}
        >
          Settings
        </MenuItem>
        <MenuItem
          icon={<Copy size={16} />}
          onClick={() => {
            copyUsername();
            close(true);
          }}
        >
          Copy username
        </MenuItem>
        {canOpenAdmin && (
          <MenuItem
            icon={<Shield size={16} />}
            onClick={() => {
              close(false);
              navigate('/app/admin');
            }}
          >
            Admin dashboard
          </MenuItem>
        )}
        <MenuItem
          icon={<Code2 size={16} />}
          onClick={() => {
            close(false);
            navigate('/app/developers');
          }}
        >
          Developer portal
        </MenuItem>

        <Divider className="my-1.5" />

        <MenuItem
          icon={<LogOut size={16} />}
          onClick={() => {
            close(false);
            void useAuthStore.getState().logout();
          }}
        >
          Sign out
        </MenuItem>
      </div>
    </Popover>
  );
}
