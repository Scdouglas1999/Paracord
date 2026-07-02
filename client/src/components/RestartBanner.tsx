import { useUIStore } from '../stores/uiStore';

export function RestartBanner() {
  const serverRestarting = useUIStore((s) => s.serverRestarting);

  if (!serverRestarting) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center bg-accent-primary px-4 py-2 text-sm font-medium text-white shadow-lg">
      Server is restarting... Reconnecting automatically.
    </div>
  );
}
