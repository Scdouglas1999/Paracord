import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Server, Settings, BarChart3, Shield, HardDrive, Globe2, type LucideIcon } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { isAdmin } from '../types';
import { Button } from '../components/ui/Button';
import { cn } from '../lib/utils';
import { OverviewPanel } from './admin/OverviewPanel';
import { UsersPanel } from './admin/UsersPanel';
import { GuildsPanel } from './admin/GuildsPanel';
import { SettingsPanel } from './admin/SettingsPanel';
import { FederationPanel } from './admin/FederationPanel';
import { SecurityPanel } from './admin/SecurityPanel';
import { BackupsPanel } from './admin/BackupsPanel';

type Tab = 'overview' | 'users' | 'guilds' | 'settings' | 'federation' | 'security' | 'backups';

const NAV: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'guilds', label: 'Guilds', icon: Server },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'federation', label: 'Federation', icon: Globe2 },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'backups', label: 'Backups', icon: HardDrive },
];

export function AdminPage() {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  if (!currentUser) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-md rounded-md border border-border-subtle bg-bg-secondary p-8 text-center shadow-sm">
          <p className="text-body text-text-muted">Checking admin access...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin(currentUser.flags ?? 0)) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-md rounded-md border border-border-subtle bg-bg-secondary p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-sm bg-danger-tint text-accent-danger">
            <Shield size={20} />
          </div>
          <h1 className="font-display text-heading text-text-primary">Access denied</h1>
          <p className="mx-auto mt-2 mb-6 max-w-xs text-body text-text-secondary">
            The control plane is limited to server administrators. Ask an admin to grant you access.
          </p>
          <Button onClick={() => navigate('/app')}>Go Back</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Sidebar nav */}
      <aside className="flex w-[clamp(11rem,24vw,16rem)] shrink-0 flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-4">
          <button
            onClick={() => navigate('/app')}
            className="flex h-9 w-9 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            aria-label="Back to home"
            title="Back to home"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="text-section uppercase text-text-muted">Control Plane</div>
            <h1 className="font-display text-heading text-text-primary">Admin</h1>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-label outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                  active
                    ? 'bg-accent-tint text-text-primary'
                    : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-secondary" />
                )}
                <Icon size={16} className={active ? 'text-accent-primary' : 'text-channel-icon'} />
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <main className="min-w-0 flex-1 overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
        <div className="h-full overflow-y-auto p-6 md:p-8">
          {activeTab === 'overview' && <OverviewPanel />}
          {activeTab === 'users' && <UsersPanel />}
          {activeTab === 'guilds' && <GuildsPanel />}
          {activeTab === 'settings' && <SettingsPanel />}
          {activeTab === 'federation' && <FederationPanel />}
          {activeTab === 'security' && <SecurityPanel />}
          {activeTab === 'backups' && <BackupsPanel />}
        </div>
      </main>
    </div>
  );
}
