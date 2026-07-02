import { UserSettings } from '../components/user/UserSettings';
import { useUIStore } from '../stores/uiStore';

export function SettingsPage() {
  const setUserSettingsOpen = useUIStore((s) => s.setUserSettingsOpen);

  return <UserSettings onClose={() => setUserSettingsOpen(false)} />;
}
