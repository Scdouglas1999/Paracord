import { useParams, useNavigate } from 'react-router-dom';
import { GuildSettings } from '../components/guild/GuildSettings';
import { useGuildStore } from '../stores/guildStore';
import { usePermissions } from '../hooks/usePermissions';
import { Permissions, hasPermission } from '../types';

export function GuildSettingsPage() {
  const { guildId } = useParams();
  const navigate = useNavigate();
  const guilds = useGuildStore(s => s.guilds);
  const guild = guilds.find(g => g.id === guildId);
  const { permissions, isAdmin, isLoading } = usePermissions(guildId || null);
  const canManageGuild = isAdmin || hasPermission(permissions, Permissions.MANAGE_GUILD);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="settings-surface-card w-full max-w-md text-center">
          <p className="text-sm leading-6 text-text-muted">Loading permissions...</p>
        </div>
      </div>
    );
  }

  if (!canManageGuild) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="settings-surface-card w-full max-w-md text-center">
          <h2 className="mb-4 text-xl font-semibold text-text-primary">Access denied</h2>
          <p className="mb-8 text-sm leading-6 text-text-muted">
            You need Manage Server permission to open server settings.
          </p>
          <button className="btn-primary" onClick={() => navigate(-1)}>
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <GuildSettings
      guildId={guildId || ''}
      guildName={guild?.name || 'Server'}
      onClose={() => navigate(-1)}
    />
  );
}
