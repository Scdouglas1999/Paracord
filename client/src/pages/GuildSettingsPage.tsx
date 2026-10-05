import { useEffect, useRef, useState } from 'react';
import { useCurrentGuilds } from '../hooks/useGuilds';
import { GuildSettings } from '../components/guild/GuildSettings';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { CSSProperties } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { canAccessGuildSettings } from '../lib/guildSettingsAccess';
import { useUIStore } from '../stores/uiStore';
import { LoadingSpinner } from '../components/ui';
import { EmptyPage } from '../components/ix/page';
import { CreamButton } from '../components/ix/primitives';
import { serverHue } from '../lib/identityHue';

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

  // Both pre-flight states render on the settings surface itself (the ground, in
  // the server's hue), so the surface the reader lands on is the one the settings
  // will occupy.
  const preflightStyle = { '--ix-hue': serverHue({ id: guildId ?? '', hue: guild?.hue ?? null }) } as CSSProperties;
  if (awaitingFirstAnswer) {
    return (
      <div className="ix-settings ix-lt ix-hue-main items-center justify-center" style={preflightStyle}>
        <LoadingSpinner size="sm" label="Checking your permissions in this server" />
      </div>
    );
  }

  if (!canOpenSettings) {
    return (
      <div className="ix-settings ix-lt ix-hue-main" style={preflightStyle}>
        <EmptyPage
          glyph="lock"
          role="alert"
          title="Server settings are locked"
          line="You need a moderation or management permission (Manage Server, Manage Channels, Ban Members or View Audit log) to open settings here. Ask an admin to grant one, or head back to the conversation."
          action={<CreamButton onClick={closeSettings}>Back to the server</CreamButton>}
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
