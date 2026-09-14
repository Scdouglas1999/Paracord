import { useEffect, useRef, useState } from 'react';
import { useCurrentGuilds } from '../hooks/useGuilds';
import { GuildSettings } from '../components/guild/GuildSettings';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ShieldAlert } from 'lucide-react';
import { usePermissions } from '../hooks/usePermissions';
import { canAccessGuildSettings } from '../lib/guildSettingsAccess';
import { useUIStore } from '../stores/uiStore';
import { Button, EmptyState, LoadingSpinner } from '../components/ui';

export { canAccessGuildSettings } from '../lib/guildSettingsAccess';

export function GuildSettingsPage() {
  const { guildId: routeGuildId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const overlayGuildId = useUIStore((s) => s.guildSettingsId);
  const overlayInitialSection = useUIStore((s) => s.guildSettingsInitialSection);
  const overlayChannelId = useUIStore((s) => s.guildSettingsChannelId);
  const setGuildSettingsId = useUIStore((s) => s.setGuildSettingsId);
  // The overlay entry (opened from the Lobby header or the Buildings column
  // via `guildSettingsId`)
  // takes precedence over route params. When it is set we are the windowed overlay,
  // which can be summoned from anywhere — a DM, a different guild's channel — so it
  // must only dismiss itself. Only the standalone `guilds/:id/settings` route instance
  // owns navigation back to the guild home.
  const isOverlay = Boolean(overlayGuildId);
  const guildId = overlayGuildId || routeGuildId || null;
  const initialSection = overlayInitialSection || searchParams.get('section');
  const initialChannelId = overlayChannelId || searchParams.get('channelId');

  const guilds = useCurrentGuilds();
  const guild = guilds.find((g) => g.id === guildId);
  const { permissions, isAdmin, isLoading } = usePermissions(guildId || null);
  const canOpenSettings = canAccessGuildSettings(permissions, isAdmin);

  // `usePermissions` re-fetches this building's roles whenever the gateway
  // reports a role change — including the role YOU just created or saved on the
  // Roles screen. Swapping in the spinner on that refresh unmounts
  // `GuildSettings`, and with it every piece of its state: the section you were
  // on, the role you were editing, half-typed fields in any other section. It
  // came back at Overview and your work was gone. The spinner is a first-answer
  // state, so show it only until this building's permissions resolve once.
  const [resolvedGuildId, setResolvedGuildId] = useState<string | null>(null);
  const lastGuildId = useRef<string | null>(guildId);
  if (lastGuildId.current !== guildId) {
    lastGuildId.current = guildId;
    if (resolvedGuildId !== guildId) setResolvedGuildId(null);
  }
  useEffect(() => {
    if (!isLoading && guildId) setResolvedGuildId(guildId);
  }, [isLoading, guildId]);
  const awaitingFirstAnswer = isLoading && resolvedGuildId !== guildId;
  const closeSettings = () => {
    setGuildSettingsId(null);
    if (!isOverlay && routeGuildId) {
      navigate(`/app/guilds/${routeGuildId}`);
    }
  };

  // Both pre-flight states render on the settings plate itself (spec §4), so the
  // surface the reader lands on is the same one the settings will occupy.
  if (awaitingFirstAnswer) {
    return (
      <div className="pc-plate flex h-full min-h-0 items-center px-6 sm:px-10">
        <LoadingSpinner size="sm" label="Checking your permissions in this building" />
      </div>
    );
  }

  if (!canOpenSettings) {
    return (
      <div className="pc-plate flex h-full min-h-0 items-center px-6 sm:px-10">
        <EmptyState
          className="w-full max-w-prose"
          icon={<ShieldAlert size={20} strokeWidth={2} />}
          title="Building settings are locked"
          description="You need a moderation or management permission — Manage Building, Manage Channels, Ban Members or View Audit log — to open settings here. Ask an admin to grant one, or head back to the conversation."
          action={<Button onClick={closeSettings}>Back to the server</Button>}
        />
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
