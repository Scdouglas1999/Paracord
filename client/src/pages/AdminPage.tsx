import { useCurrentUser } from '../hooks/useCurrentUser';
import { useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { Users, Server, Settings, BarChart3, Shield, HardDrive, Globe2 } from 'lucide-react';
import { isAdmin } from '../types';
import {
  Button,
  EmptyState,
  LoadingSpinner,
  Plate,
  SettingsShell,
  type SettingsNavGroup,
} from '../components/ui';
import { useMobile } from '../hooks/useMobile';
import { OverviewPanel } from './admin/OverviewPanel';
import { UsersPanel } from './admin/UsersPanel';
import { GuildsPanel } from './admin/GuildsPanel';
import { SettingsPanel } from './admin/SettingsPanel';
import { FederationPanel } from './admin/FederationPanel';
import { SecurityPanel } from './admin/SecurityPanel';
import { BackupsPanel } from './admin/BackupsPanel';

type Tab = 'overview' | 'users' | 'guilds' | 'settings' | 'federation' | 'security' | 'backups';

/**
 * The control plane is a settings surface (spec §4): one plate over the street,
 * a left index of sections in sentence case, the section's content beside it.
 * Every tab id, the admin gate and the route are unchanged — only the shape is.
 */
const NAV_GROUPS: SettingsNavGroup[] = [
  {
    items: [{ id: 'overview', label: 'Overview', icon: <BarChart3 size={16} /> }],
  },
  {
    label: 'People and buildings',
    items: [
      { id: 'users', label: 'Users', icon: <Users size={16} /> },
      { id: 'guilds', label: 'Guilds', icon: <Server size={16} /> },
      { id: 'federation', label: 'Federation', icon: <Globe2 size={16} /> },
    ],
  },
  {
    label: 'This deployment',
    items: [
      { id: 'settings', label: 'Settings', icon: <Settings size={16} /> },
      { id: 'security', label: 'Security', icon: <Shield size={16} /> },
      { id: 'backups', label: 'Backups', icon: <HardDrive size={16} /> },
    ],
  },
];

export function AdminPage() {
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const isMobile = useMobile();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [showIndex, setShowIndex] = useState(true);

  const goHome = () => navigate('/app');

  if (!currentUser) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <Plate className="w-full max-w-md px-6 py-8">
          <LoadingSpinner size="sm" label="Checking admin access..." />
        </Plate>
      </div>
    );
  }

  if (!isAdmin(currentUser.flags ?? 0)) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <Plate className="w-full max-w-md px-6 py-2">
          <EmptyState
            role="alert"
            icon={<Shield size={20} />}
            title="Access denied"
            description="The control plane is limited to server administrators. Ask an admin to grant you access, then come back."
            action={<Button onClick={goHome}>Go back</Button>}
          />
        </Plate>
      </div>
    );
  }

  // Escape closes the surface, which is what the shell's Esc hint promises.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    goHome();
  };

  return (
    <SettingsShell
      label="Server administration"
      title="Admin"
      groups={NAV_GROUPS}
      active={activeTab}
      onSelect={(id) => {
        setActiveTab(id as Tab);
        setShowIndex(false);
      }}
      onClose={goHome}
      closeLabel="Back to home"
      isMobile={isMobile}
      showIndex={showIndex}
      onShowIndex={setShowIndex}
      onKeyDown={onKeyDown}
    >
      {activeTab === 'overview' && <OverviewPanel />}
      {activeTab === 'users' && <UsersPanel />}
      {activeTab === 'guilds' && <GuildsPanel />}
      {activeTab === 'settings' && <SettingsPanel />}
      {activeTab === 'federation' && <FederationPanel />}
      {activeTab === 'security' && <SecurityPanel />}
      {activeTab === 'backups' && <BackupsPanel />}
    </SettingsShell>
  );
}
