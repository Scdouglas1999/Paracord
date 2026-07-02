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

  return (
    <div className="panel-divider shrink-0 border-t px-2.5 py-2.5">
      <div className="flex items-center">
        <button
          type="button"
          className="mr-2 flex min-w-0 flex-1 items-center rounded-xl p-2 text-left transition-colors hover:bg-bg-mod-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-tertiary"
          aria-label={`Copy username ${user?.username || 'User'}`}
          onClick={() => {
            void writeClipboardText(user?.username || '')
              .then(() => toast.success('Username copied.'))
              .catch((err) => toast.error(`Failed to copy username: ${err instanceof Error ? err.message : String(err)}`));
          }}
        >
          <div className="relative mr-2 shrink-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-primary text-sm font-semibold text-white shadow-sm">
              {user?.username?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-online border-[2px] border-bg-tertiary" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight text-text-primary">
              {user?.username || 'User'}
            </div>
            <div className="truncate text-[11px] leading-tight text-text-muted">
              #{user?.id?.slice(0, 4) || '0000'}
            </div>
          </div>
        </button>

        <div className="flex items-center gap-1.5">
          <Tooltip content={muted ? "Unmute" : "Mute"}>
            <button
              onClick={onToggleMute}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              title={muted ? 'Unmute microphone' : 'Mute microphone'}
              className={cn(
                'relative flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary',
                muted && "text-accent-danger"
              )}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
              {muted && <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-accent-danger"><div className="w-6 h-0.5 bg-accent-danger rotate-45 transform" /></div>}
            </button>
          </Tooltip>
          <Tooltip content={deafened ? "Undeafen" : "Deafen"}>
            <button
              onClick={onToggleDeaf}
              aria-label={deafened ? 'Undeafen audio' : 'Deafen audio'}
              title={deafened ? 'Undeafen audio' : 'Deafen audio'}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary',
                deafened && "text-accent-danger"
              )}
            >
              {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
            </button>
          </Tooltip>
          <Tooltip content="User Settings">
            <button
              onClick={() => useUIStore.getState().setUserSettingsOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary"
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
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary"
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
