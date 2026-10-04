import { useNavigate } from 'react-router';

import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { guildLandingPath } from '../../../lib/guildNavigation';
import { serverHue } from '../../../lib/identityHue';
import { toast } from '../../../stores/toastStore';
import { IxGlyph } from '../glyphs';
import { Avatar, ServerMark } from '../identity';
import { useIxShell } from '../shell/IxShellContext';
import { placeKey } from '../shell/place';
import type { DockSlotProps } from '../shell/slots';

/**
 * STUB (IX-4). Owner: IX-6, which replaces this file (and its `.ix-dock-stub`
 * rules at the end of styles/ix-shell.css) with the dock (index-spec §4.8).
 *
 * Just enough to switch place: People, a separator, the servers in
 * `usePlaceOrder()`'s order, and `+` (Discover, for now). Static: no indicator
 * glide, no live or unread dots, no roving focus. It carries the §1.3 test ids
 * (`ix-dock`, `ix-dock-item[data-place]`) so the drivers work against it.
 */
export function DockSlot(_props: DockSlotProps) {
  const navigate = useNavigate();
  const { place } = useIxShell();
  const user = useCurrentUser();
  const guilds = useAvailableGuilds();
  const current = placeKey(place);

  return (
    <div className="ix-dock-stub" role="toolbar" aria-label="Servers" data-testid="ix-dock">
      {user && (
        <button
          type="button"
          className="ix-dock-stub__item"
          data-testid="ix-dock-item"
          data-place="people"
          data-current={current === 'people' ? 'true' : undefined}
          aria-label="People"
          aria-current={current === 'people' ? 'page' : undefined}
          title="People"
          onClick={() => navigate('/app/dms')}
        >
          <Avatar userId={user.id} name={user.display_name || user.username} avatar={user.avatar_hash ?? null} size={34} />
        </button>
      )}
      <span className="ix-dock-stub__sep" aria-hidden="true" />
      {guilds.map((guild) => (
        <button
          key={guild.id}
          type="button"
          className="ix-dock-stub__item"
          data-testid="ix-dock-item"
          data-place={guild.id}
          data-current={current === guild.id ? 'true' : undefined}
          aria-label={guild.name}
          aria-current={current === guild.id ? 'page' : undefined}
          title={guild.name}
          onClick={() => {
            void guildLandingPath(guild).then(
              (path) => navigate(path),
              (error: unknown) => toast.error(error instanceof Error ? error.message : 'Could not open that server.'),
            );
          }}
        >
          <ServerMark guildId={guild.id} name={guild.name} icon={guild.icon_hash ?? guild.icon ?? null} hue={serverHue(guild)} size={34} />
        </button>
      ))}
      <button
        type="button"
        className="ix-dock-stub__item ix-dock-stub__add"
        aria-label="Join or create a server"
        title="Join or create a server"
        onClick={() => navigate('/app/discovery')}
      >
        <span>
          <IxGlyph name="plus" size={16} />
        </span>
      </button>
    </div>
  );
}
