import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, Settings, Shield, ChevronDown } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { gateway } from '../../gateway/manager';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { writeClipboardText } from '../../lib/clipboard';
import { toast } from '../../stores/toastStore';
import { displayName } from '../../lib/displayName';
import type { UserSettings } from '../../types';

interface UserPanelProps {
  user: { id: string; username: string; display_name?: string | null; email?: string; flags?: number } | null;
  navigate: (path: string) => void;
  muted: boolean;
  deafened: boolean;
  onToggleMute: () => void;
  onToggleDeaf: () => void;
  showAdminDashboard: boolean;
}

type PresenceStatus = UserSettings['status'];

const STATUS_OPTIONS: Array<{ id: PresenceStatus; label: string; color: string }> = [
  { id: 'online', label: 'Online', color: 'bg-status-online' },
  { id: 'idle', label: 'Idle', color: 'bg-status-idle' },
  { id: 'dnd', label: 'Do Not Disturb', color: 'bg-status-dnd' },
  { id: 'invisible', label: 'Invisible', color: 'bg-status-offline' },
];

function statusDotClass(status: PresenceStatus | undefined): string {
  switch (status) {
    case 'idle':
      return 'bg-status-idle';
    case 'dnd':
      return 'bg-status-dnd';
    case 'invisible':
      return 'bg-status-offline';
    default:
      return 'bg-status-online';
  }
}

function statusLabel(status: PresenceStatus | undefined, custom?: string | null): string {
  if (custom?.trim()) return custom.trim();
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'dnd':
      return 'Do Not Disturb';
    case 'invisible':
      return 'Invisible';
    default:
      return 'Online';
  }
}

function mapForGateway(status: PresenceStatus): 'online' | 'idle' | 'dnd' | 'offline' {
  if (status === 'invisible') return 'offline';
  return status;
}

export function UserPanel({
  user,
  navigate,
  muted,
  deafened,
  onToggleMute,
  onToggleDeaf,
  showAdminDashboard,
}: UserPanelProps) {
  const userFlags = Number(user?.flags ?? 0);
  const canOpenAdminDashboard = showAdminDashboard || (Number.isFinite(userFlags) && (userFlags & 1) !== 0);
  const settings = useAuthStore((s) => s.settings);
  const updateSettings = useAuthStore((s) => s.updateSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState(settings?.custom_status ?? '');
  const menuRef = useRef<HTMLDivElement>(null);

  const status = settings?.status ?? 'online';
  const customStatus = settings?.custom_status ?? null;

  const copyUsername = () => {
    void writeClipboardText(user?.username || '')
      .then(() => toast.success('Username copied.'))
      .catch((err) => toast.error(`Failed to copy username: ${err instanceof Error ? err.message : String(err)}`));
  };

  useEffect(() => {
    setCustomDraft(settings?.custom_status ?? '');
  }, [settings?.custom_status]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const applyStatus = async (next: PresenceStatus, custom?: string | null) => {
    try {
      await updateSettings({
        status: next,
        custom_status: custom === undefined ? (settings?.custom_status ?? null) : custom,
      } as Partial<import('../../types').UserSettings>);
      const gatewayStatus = mapForGateway(next);
      gateway.updatePresenceAll(gatewayStatus, []);
      if (user?.id) {
        usePresenceStore.getState().updatePresence({
          user_id: user.id,
          status: gatewayStatus,
          activities: [],
        });
      }
    } catch (err) {
      toast.error(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Icon-button recipe (design-spec §7): 36px square, radius-sm, interactive-normal
  // icon that lifts to interactive-hover on a subtle wash, layered focus ring.
  const iconButton =
    'flex h-9 w-9 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]';

  return (
    <div className="panel-divider shrink-0 border-t px-2 py-2">
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1" ref={menuRef}>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-sm p-1.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
            aria-label={`Status: ${statusLabel(status, customStatus)}. Change status`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((open) => !open)}
            onContextMenu={(e) => {
              e.preventDefault();
              copyUsername();
            }}
          >
            <div className="relative shrink-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary text-label font-semibold text-text-on-accent shadow-sm">
                {displayName(user).charAt(0).toUpperCase()}
              </div>
              <div
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-bg-secondary',
                  statusDotClass(status),
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-label font-semibold leading-tight text-text-primary">
                {displayName(user)}
              </div>
              <div className="truncate text-meta leading-tight text-text-muted">
                {statusLabel(status, customStatus)}
              </div>
            </div>
            <ChevronDown size={14} className="shrink-0 text-text-muted" aria-hidden />
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label="Set your status"
              className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-md border border-border-subtle bg-bg-floating p-1.5 shadow-lg"
            >
              {STATUS_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={status === option.id}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-label outline-none transition-colors hover:bg-bg-mod-subtle',
                    status === option.id ? 'text-text-primary' : 'text-text-secondary',
                  )}
                  onClick={() => {
                    void applyStatus(option.id);
                    setMenuOpen(false);
                  }}
                >
                  <span className={cn('h-2.5 w-2.5 rounded-full', option.color)} />
                  {option.label}
                </button>
              ))}
              <div className="mt-1 border-t border-border-subtle pt-1">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={user?.username ? `Copy username ${user.username}` : 'Copy username'}
                  className="flex w-full rounded-sm px-2 py-1.5 text-left text-label text-text-secondary outline-none transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                  onClick={() => {
                    copyUsername();
                    setMenuOpen(false);
                  }}
                >
                  Copy username
                </button>
              </div>
              <div className="mt-1 border-t border-border-subtle pt-1.5">
                <label className="px-2 text-meta text-text-muted" htmlFor="user-panel-custom-status">
                  Custom status
                </label>
                <div className="mt-1 flex gap-1 px-1">
                  <input
                    id="user-panel-custom-status"
                    className="min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-tertiary px-2 py-1 text-meta text-text-primary outline-none focus:border-accent-primary"
                    value={customDraft}
                    maxLength={128}
                    placeholder="What's up?"
                    onChange={(e) => setCustomDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void applyStatus(status, customDraft.trim() || null);
                        setMenuOpen(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="rounded-sm bg-accent-primary px-2 py-1 text-meta font-semibold text-text-on-accent"
                    onClick={() => {
                      void applyStatus(status, customDraft.trim() || null);
                      setMenuOpen(false);
                    }}
                  >
                    Set
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5">
          <Tooltip content={muted ? 'Unmute' : 'Mute'}>
            <button
              onClick={onToggleMute}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              title={muted ? 'Unmute microphone' : 'Mute microphone'}
              className={cn(iconButton, muted && 'text-accent-danger hover:text-accent-danger')}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          </Tooltip>
          <Tooltip content={deafened ? 'Undeafen' : 'Deafen'}>
            <button
              onClick={onToggleDeaf}
              aria-label={deafened ? 'Undeafen audio' : 'Deafen audio'}
              title={deafened ? 'Undeafen audio' : 'Deafen audio'}
              className={cn(iconButton, deafened && 'text-accent-danger hover:text-accent-danger')}
            >
              {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
            </button>
          </Tooltip>
          <Tooltip content="User Settings">
            <button
              onClick={() => useUIStore.getState().setUserSettingsOpen(true)}
              className={iconButton}
              aria-label="Open user settings"
              title="Open user settings"
            >
              <Settings size={18} />
            </button>
          </Tooltip>
          {canOpenAdminDashboard && (
            <Tooltip content="Admin Dashboard">
              <button
                type="button"
                onClick={() => navigate('/app/admin')}
                className={iconButton}
                aria-label="Open admin dashboard"
                title="Open admin dashboard"
              >
                <Shield size={18} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
