import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Clock, Code2, Copy, Keyboard, LogOut, Settings, Shield, UserRound } from 'lucide-react';

import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { writeClipboardText } from '../../../lib/clipboard';
import { displayName } from '../../../lib/displayName';
import { presenceLabel } from '../../../lib/presence';
import { publishPresence } from '../../../lib/presenceActivities';
import { useAuthStore } from '../../../stores/authStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { isAdmin, type UserSettings } from '../../../types';
import { closeSheets, openReminders } from '../../glass/sheets/sheetStore';
import { IxGlyph } from '../glyphs';
import { Avatar, PresenceDot } from '../identity';
import type { MenuAnchor } from './anchor';
import { openHelp } from './hostStore';
import { IxMenuItems, IxMenuSurface, type IxMenuEntry } from './IxMenu';
import { ACCOUNT_MENU_ANCHOR } from './accountMenuOpener';
import { modHint } from './menuUtils';

/**
 * The account menu (docs/index-spec.md §6.4): the toolbar's avatar opens a
 * popover 280 wide that hangs from the avatar's own edge. Your avatar 40, name
 * and username; Status (Online / Idle / Do not disturb / Invisible); a line of
 * your own; Profile; Reminders; Settings (Ctrl ,); Keyboard shortcuts (Ctrl /);
 * Admin (instance admins); Developer portal; Copy username; Sign out.
 *
 * Open state is `glassStore.sheet === 'account'` (the toolbar calls
 * `openAccountMenu()`; Reminders is the one page of the account sheet), so a
 * keyboard shortcut or another surface can open it without a handle on this
 * component. It is mounted once, by the menu host.
 */

type Status = 'online' | 'idle' | 'dnd' | 'invisible';

const STATUS_OPTIONS: Array<{ id: Status; label: string }> = [
  { id: 'online', label: 'Online' },
  { id: 'idle', label: 'Idle' },
  { id: 'dnd', label: 'Do not disturb' },
  { id: 'invisible', label: 'Invisible' },
];

function accountAnchor(): MenuAnchor {
  const element = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(ACCOUNT_MENU_ANCHOR);
  if (element) return { element, align: 'end' };
  // No toolbar on screen (a page that has none): top right, where it would hang.
  return { x: typeof window === 'undefined' ? 0 : window.innerWidth - 16, y: 56 };
}

function StatusMark({ status }: { status: Status }) {
  if (status === 'invisible') return <span className="ix-menu__dot ix-menu__dot--invisible" aria-hidden />;
  return <PresenceDot status={status} inline ring="var(--ix-pop-solid)" />;
}

export function AccountMenu({ open }: { open: boolean }) {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const settings = useAuthStore((s) => s.settings);
  const updateSettings = useAuthStore((s) => s.updateSettings);
  const [customDraft, setCustomDraft] = useState<string | null>(null);

  // Looked up when the menu opens: the toolbar's avatar may not be on screen while it is closed.
  const anchor = useMemo(() => (open ? accountAnchor() : null), [open]);

  const status: Status = (settings?.status as Status | undefined) ?? 'online';
  const customStatus = settings?.custom_status ?? '';
  const draft = customDraft ?? customStatus;
  const name = displayName(user);
  const caption = customStatus.trim() || (status === 'invisible' ? 'Invisible' : presenceLabel(status));
  const canOpenAdmin = Boolean(user && isAdmin(Number(user.flags ?? 0)));

  const close = () => {
    closeSheets();
    setCustomDraft(null);
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

  const entries: IxMenuEntry[] = [];
  const statusEntries: IxMenuEntry[] = STATUS_OPTIONS.map((option) => ({
    type: 'item',
    id: `status-${option.id}`,
    label: option.label,
    icon: <StatusMark status={option.id} />,
    checked: status === option.id,
    onSelect: () => void applyStatus(option.id),
  }));
  const doorEntries: IxMenuEntry[] = [
    {
      type: 'item',
      id: 'profile',
      label: 'Profile',
      icon: <UserRound size={16} strokeWidth={1.7} />,
      onSelect: () => useUIStore.getState().setUserSettingsOpen(true, 'account'),
    },
    {
      type: 'item',
      id: 'reminders',
      label: 'Reminders',
      icon: <Clock size={16} strokeWidth={1.7} />,
      // The menu gives way to the reminders sheet: stay "open" for the store, which closes it.
      keepOpen: true,
      onSelect: () => openReminders(),
    },
    {
      type: 'item',
      id: 'settings',
      label: 'Settings',
      icon: <Settings size={16} strokeWidth={1.7} />,
      hint: modHint(','),
      onSelect: () => useUIStore.getState().setUserSettingsOpen(true),
    },
    {
      type: 'item',
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      icon: <Keyboard size={16} strokeWidth={1.7} />,
      hint: modHint('/'),
      onSelect: () => openHelp(),
    },
  ];
  if (canOpenAdmin) {
    doorEntries.push({
      type: 'item',
      id: 'admin',
      label: 'Admin dashboard',
      icon: <Shield size={16} strokeWidth={1.7} />,
      onSelect: () => navigate('/app/admin'),
    });
  }
  doorEntries.push(
    {
      type: 'item',
      id: 'developer',
      label: 'Developer portal',
      icon: <Code2 size={16} strokeWidth={1.7} />,
      onSelect: () => navigate('/app/developers'),
    },
    {
      type: 'item',
      id: 'copy',
      label: 'Copy username',
      icon: <Copy size={16} strokeWidth={1.7} />,
      onSelect: () => {
        void writeClipboardText(user?.username || '')
          .then(() => toast.success('Username copied.'))
          .catch((err) => toast.error(`Failed to copy username: ${err instanceof Error ? err.message : String(err)}`));
      },
    },
  );
  const leaveEntries: IxMenuEntry[] = [
    {
      type: 'item',
      id: 'sign-out',
      label: 'Sign out',
      icon: <LogOut size={16} strokeWidth={1.7} />,
      onSelect: () => void useAuthStore.getState().logout(),
    },
  ];

  return (
    <IxMenuSurface
      open={open}
      onClose={() => close()}
      anchor={anchor}
      label="Account"
      width={280}
      className="ix-account"
      restoreTo={() => document.querySelector<HTMLElement>(ACCOUNT_MENU_ANCHOR)}
      testId="ix-account-menu"
    >
      <div role="presentation" className="ix-menu__who">
        <Avatar userId={user?.id ?? '0'} name={name} avatar={user?.avatar_hash ?? null} size={40} />
        <span className="ix-menu__who-text">
          <span className="ix-menu__who-name">{name}</span>
          <span className="ix-menu__who-sub">{user?.username ? `@${user.username}` : caption}</span>
        </span>
      </div>

      <IxMenuItems
        entries={[{ type: 'label', id: 'status-label', label: 'Status' }, ...statusEntries, ...entries]}
        onClose={() => close()}
      />

      <div className="ix-menu__custom">
        <input
          id="account-menu-custom-status"
          aria-label="Custom status"
          className="ix-field ix-menu__field"
          value={draft}
          maxLength={128}
          placeholder="Set a custom status"
          onChange={(event) => setCustomDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void applyStatus(status, draft.trim() || null);
            close();
          }}
        />
        <button
          type="button"
          className="ix-menu__set"
          aria-label="Set custom status"
          onClick={() => {
            void applyStatus(status, draft.trim() || null);
            close();
          }}
        >
          <IxGlyph name="check" size={16} />
        </button>
      </div>

      <IxMenuItems entries={[{ type: 'separator', id: 'sep-doors' }, ...doorEntries, { type: 'separator', id: 'sep-out' }, ...leaveEntries]} onClose={() => close()} />
    </IxMenuSurface>
  );
}
