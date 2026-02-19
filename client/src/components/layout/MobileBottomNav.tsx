import { useLocation, useNavigate } from 'react-router-dom';
import { Home, MessageSquare, Hash, Users, Settings } from 'lucide-react';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';

interface Tab {
  id: string;
  icon: typeof Home;
  label: string;
}

const TABS: Tab[] = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'dms', icon: MessageSquare, label: 'DMs' },
  { id: 'server', icon: Hash, label: 'Server' },
  { id: 'friends', icon: Users, label: 'Friends' },
  { id: 'settings', icon: Settings, label: 'Settings' },
];

export function MobileBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);

  const activeTab = (() => {
    const path = location.pathname;
    if (path === '/app' || path === '/app/') return 'home';
    if (path.startsWith('/app/dms')) return 'dms';
    if (path.startsWith('/app/friends')) return 'friends';
    if (path === '/app/settings') return 'settings';
    if (path.startsWith('/app/guilds')) return 'server';
    return 'home';
  })();

  const handleTabPress = (tabId: string) => {
    switch (tabId) {
      case 'home':
        navigate('/app');
        break;
      case 'dms':
        navigate('/app/dms');
        break;
      case 'server':
        if (selectedGuildId && selectedChannelId) {
          navigate(`/app/guilds/${selectedGuildId}/channels/${selectedChannelId}`);
        } else if (selectedGuildId) {
          // Open channel sidebar for this guild
          setSidebarCollapsed(false);
        } else {
          navigate('/app');
        }
        break;
      case 'friends':
        navigate('/app/friends');
        break;
      case 'settings':
        navigate('/app/settings');
        break;
    }
  };

  return (
    <nav
      className="mobile-bottom-nav flex items-center justify-around border-t border-border-subtle/60 md:hidden"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--bg-secondary) 95%, transparent)',
        paddingBottom: 'var(--safe-bottom, 0px)',
      }}
      aria-label="Main navigation"
    >
      {TABS.map(({ id, icon: Icon, label }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => handleTabPress(id)}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 transition-colors"
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            style={{
              color: isActive ? 'var(--accent-primary)' : 'var(--text-muted)',
            }}
          >
            <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
            <span className="text-[10px] font-semibold leading-tight">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
