import { useLocation, useNavigate } from 'react-router-dom';
import { Home, MessageSquare, Hash, Users, Settings } from 'lucide-react';
import { useGuildStore } from '../../stores/guildStore';
import { useUIStore } from '../../stores/uiStore';

interface Tab {
  id: string;
  icon: typeof Home;
  label: string;
}

const TABS: Tab[] = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'dms', icon: MessageSquare, label: 'DMs' },
  { id: 'space', icon: Hash, label: 'Space' },
  { id: 'friends', icon: Users, label: 'Friends' },
  { id: 'settings', icon: Settings, label: 'Settings' },
];

export function MobileBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const guilds = useGuildStore((s) => s.guilds);
  const userSettingsOpen = useUIStore((s) => s.userSettingsOpen);

  const activeTab = (() => {
    if (userSettingsOpen) return 'settings';
    const path = location.pathname;
    if (path === '/app' || path === '/app/') return 'home';
    if (path.startsWith('/app/dms')) return 'dms';
    if (path.startsWith('/app/friends')) return 'friends';
    if (path.startsWith('/app/guilds')) return 'space';
    return 'home';
  })();

  const handleTabPress = (tabId: string) => {
    switch (tabId) {
      case 'home':
        useUIStore.getState().setUserSettingsOpen(false);
        navigate('/app');
        break;
      case 'dms':
        useUIStore.getState().setUserSettingsOpen(false);
        navigate('/app/dms');
        break;
      case 'space':
        {
          useUIStore.getState().setUserSettingsOpen(false);
          const targetGuildId = guilds.some((guild) => guild.id === selectedGuildId)
            ? selectedGuildId
            : guilds[0]?.id;
          if (targetGuildId) {
            useGuildStore.getState().selectGuild(targetGuildId);
            navigate(`/app/guilds/${targetGuildId}`);
          } else {
            navigate('/app');
          }
        }
        break;
      case 'friends':
        useUIStore.getState().setUserSettingsOpen(false);
        navigate('/app/friends');
        break;
      case 'settings':
        useUIStore.getState().setUserSettingsOpen(!userSettingsOpen);
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
            className="flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-sm py-1.5 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]"
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            style={{
              color: isActive ? 'var(--accent-primary)' : 'var(--text-muted)',
            }}
          >
            <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
            <span className="text-meta font-semibold leading-none">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
