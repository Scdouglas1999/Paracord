import { Mic, MicOff, Headphones, HeadphoneOff, Settings, Shield } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { writeClipboardText } from '../../lib/clipboard';
import { toast } from '../../stores/toastStore';

interface UserPanelProps {
  user: { id: string; username: string; email?: string; flags?: number } | null;
  navigate: (path: string) => void;
  muted: boolean;
  deafened: boolean;
  onToggleMute: () => void;
  onToggleDeaf: () => void;
  showAdminDashboard: boolean;
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

  // Icon-button recipe (design-spec §7): 36px square, radius-sm, interactive-normal
  // icon that lifts to interactive-hover on a subtle wash, layered focus ring.
  const iconButton =
    'flex h-9 w-9 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]';

  return (
    <div className="panel-divider shrink-0 border-t px-2 py-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm p-1.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
          aria-label={`Copy username ${user?.username || 'User'}`}
          onClick={() => {
            void writeClipboardText(user?.username || '')
              .then(() => toast.success('Username copied.'))
              .catch((err) => toast.error(`Failed to copy username: ${err instanceof Error ? err.message : String(err)}`));
          }}
        >
          <div className="relative shrink-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary text-label font-semibold text-text-on-accent shadow-sm">
              {user?.username?.charAt(0).toUpperCase() || 'U'}
            </div>
            {/* Presence dot ringed in the surface behind the panel (bg-secondary) */}
            <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-status-online ring-2 ring-bg-secondary" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-label font-semibold leading-tight text-text-primary">
              {user?.username || 'User'}
            </div>
            <div className="truncate text-meta leading-tight text-text-muted">
              Online
            </div>
          </div>
        </button>

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
