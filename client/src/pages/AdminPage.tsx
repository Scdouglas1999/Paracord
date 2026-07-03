import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Server, Settings, BarChart3, Shield, HardDrive, Globe2 } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { isAdmin } from '../types';
import { OverviewPanel } from './admin/OverviewPanel';
import { UsersPanel } from './admin/UsersPanel';
import { GuildsPanel } from './admin/GuildsPanel';
import { SettingsPanel } from './admin/SettingsPanel';
import { FederationPanel } from './admin/FederationPanel';
import { SecurityPanel } from './admin/SecurityPanel';
import { BackupsPanel } from './admin/BackupsPanel';

type Tab = 'overview' | 'users' | 'guilds' | 'settings' | 'federation' | 'security' | 'backups';

export function AdminPage() {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  if (!currentUser) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="settings-surface-card w-full max-w-md text-center">
          <p className="text-sm leading-6 text-text-muted">Checking admin access...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin(currentUser.flags ?? 0)) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="settings-surface-card w-full max-w-md text-center">
          <h1 className="mb-4 text-xl font-semibold text-text-primary">Access denied</h1>
          <p className="mb-8 text-sm leading-6 text-text-muted">
            You need administrator access to open the control plane.
          </p>
          <button className="btn-primary" onClick={() => navigate('/app')}>
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Sidebar nav */}
      <aside className="panel-surface flex w-64 min-w-[16rem] flex-col overflow-hidden">
        <div className="panel-divider flex items-center gap-3 border-b px-4 py-4">
          <button
            onClick={() => navigate(-1)}
            className="command-icon-btn"
            aria-label="Go back"
            title="Go back"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Control Plane</div>
            <h1 className="text-lg font-semibold text-text-primary">Admin</h1>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-4">
          {([
            { id: 'overview' as Tab, label: 'Overview', icon: BarChart3 },
            { id: 'users' as Tab, label: 'Users', icon: Users },
            { id: 'guilds' as Tab, label: 'Guilds', icon: Server },
            { id: 'settings' as Tab, label: 'Settings', icon: Settings },
            { id: 'federation' as Tab, label: 'Federation', icon: Globe2 },
            { id: 'security' as Tab, label: 'Security', icon: Shield },
            { id: 'backups' as Tab, label: 'Backups', icon: HardDrive },
          ]).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`settings-nav-item ${
                activeTab === id
                  ? 'active'
                  : ''
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Content */}
      <main className="panel-surface min-w-0 flex-1 overflow-hidden">
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
