import { GuildSettings } from '../components/guild/GuildSettings';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2, ShieldAlert } from 'lucide-react';
import { useGuildStore } from '../stores/guildStore';
import { usePermissions } from '../hooks/usePermissions';
import { Permissions, hasPermission } from '../types';
import { useUIStore } from '../stores/uiStore';
import { Button } from '../components/ui/Button';

export function GuildSettingsPage() {
  const { guildId: routeGuildId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const overlayGuildId = useUIStore((s) => s.guildSettingsId);
  const overlayInitialSection = useUIStore((s) => s.guildSettingsInitialSection);
  const overlayChannelId = useUIStore((s) => s.guildSettingsChannelId);
  const setGuildSettingsId = useUIStore((s) => s.setGuildSettingsId);
  const guildId = overlayGuildId || routeGuildId || null;
  const initialSection = overlayInitialSection || searchParams.get('section');
  const initialChannelId = overlayChannelId || searchParams.get('channelId');

  const guilds = useGuildStore((s) => s.guilds);
  const guild = guilds.find((g) => g.id === guildId);
  const { permissions, isAdmin, isLoading } = usePermissions(guildId || null);
  const canManageGuild = isAdmin || hasPermission(permissions, Permissions.MANAGE_GUILD);
  const closeSettings = () => {
    setGuildSettingsId(null);
    if (routeGuildId) {
      navigate(`/app/guilds/${routeGuildId}`);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center bg-bg-primary px-6 sm:px-10" role="status" aria-busy="true">
        <div className="flex items-center gap-3 text-text-muted">
          <Loader2 size={18} className="animate-spin text-accent-primary" />
          <span className="text-label">Checking your server permissions…</span>
        </div>
      </div>
    );
  }

  if (!canManageGuild) {
    return (
      <div className="flex h-full items-center bg-bg-primary px-6 sm:px-10">
        <div className="w-full max-w-md">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-sm bg-warning-tint text-accent-warning">
            <ShieldAlert size={20} strokeWidth={2} />
          </div>
          <h2 className="font-display text-heading text-text-primary">
            Server settings are locked
          </h2>
          <p className="mt-2 max-w-prose text-body text-text-secondary">
            You need the <span className="font-medium text-text-primary">Manage Server</span>{' '}
            permission to change roles, channels, and moderation here. Ask an admin
            to grant it, or head back to the conversation.
          </p>
          <div className="mt-6">
            <Button onClick={closeSettings}>Back to the server</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <GuildSettings
      guildId={guildId || ''}
      guildName={guild?.name || 'Server'}
      onClose={closeSettings}
      initialSection={initialSection}
      initialChannelId={initialChannelId}
    />
  );
}
