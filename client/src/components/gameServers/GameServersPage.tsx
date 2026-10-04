import { useEffect, useState } from 'react';

import type { GameServer } from '../../api/gameServers';
import { useGameServers } from '../../hooks/useGameServers';
import { useGuild } from '../../hooks/useGuilds';
import { useUIStore } from '../../stores/uiStore';
import { EmptyPage } from '../ix/page/EmptyPage';
import { CreamButton, ToolChip } from '../ix/primitives';
import { ServerPage } from '../rooms/lobby';
import { connectUrl, detailLine, gameKindMeta, stateLabel, upCount } from './gameServerModel';
import { CopyAddressButton, GameKindIcon, PlayerPile, StatusDot } from './GameServerParts';

/** "2 of 3 up" (the sidebar row's line, docs/index-spec.md §8.3). */
function summary(servers: readonly GameServer[]): string | null {
  if (servers.length === 0) return null;
  return `${upCount(servers)} of ${servers.length} up`;
}

/**
 * The Game servers page (docs/index-spec.md §8.3): the add-on's old popover as a page
 * in main, reached from the sidebar's Add-ons row. Each server: its type, name and
 * state in words, what the instance last saw of it, who is on, and Connect (Steam) and
 * Copy address. Adding and editing them stays in Server settings › Add-ons.
 */
export function GameServersPage({ guildId }: { guildId: string }) {
  const guild = useGuild(guildId);
  const { list, status, error, servers } = useGameServers(guildId);
  const openGuildSettings = useUIStore((state) => state.openGuildSettings);
  const canManage = list?.can_manage === true;
  const [now, setNow] = useState(() => Date.now());
  // "checked 2 min ago" ages on the minute, with the re-read.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const manage = () => openGuildSettings(guildId, 'sports');

  const subtitle = [guild?.name, summary(servers)].filter(Boolean).join(' · ');
  const loading = !list && status !== 'error';

  return (
    <ServerPage guildId={guildId} title="Game servers" subtitle={subtitle || undefined} data-testid="ix-game-servers">
      {canManage && list?.enabled && servers.length > 0 && (
        <div className="ix-gs__bar">
          <ToolChip onClick={manage}>Manage in settings</ToolChip>
        </div>
      )}

      {error && (
        <div role="alert" className="ix-note" data-tone="danger">
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div role="status" aria-busy="true" aria-label="Loading game servers" className="ix-gs">
          {[0, 1].map((index) => (
            <span key={index} className="ix-gs__card ix-gs__card--skeleton" aria-hidden />
          ))}
        </div>
      ) : !list ? null : !list.enabled ? (
        <EmptyPage
          inline
          glyph="stage"
          title="Game servers are off"
          line={
            canManage
              ? 'Turn them on in Server settings to list your community’s servers and who is on.'
              : 'This server is not listing any game servers right now.'
          }
          action={canManage ? <CreamButton onClick={manage}>Open settings</CreamButton> : undefined}
        />
      ) : servers.length === 0 ? (
        <EmptyPage
          inline
          glyph="stage"
          title="No game servers yet"
          line={
            canManage
              ? 'Add a Minecraft server, a Steam game server like Counter-Strike 2 or Valheim, or any game’s port. Members see who’s on without asking in chat.'
              : 'Nobody has added a game server here yet.'
          }
          action={canManage ? <CreamButton onClick={manage}>Add a game server</CreamButton> : undefined}
        />
      ) : (
        <ul className="ix-gs" aria-label="Game servers on this server">
          {servers.map((server) => (
            <GameServerCard key={server.id} server={server} now={now} />
          ))}
        </ul>
      )}
    </ServerPage>
  );
}

function GameServerCard({ server, now }: { server: GameServer; now: number }) {
  const detail = detailLine(server.status, now);
  const connect = connectUrl(server);
  const names = server.status.state === 'up' ? server.status.player_names ?? [] : [];
  return (
    <li className="ix-gs__card" aria-label={`${server.name}, ${stateLabel(server.status.state)}`}>
      <div className="ix-gs__head">
        <GameKindIcon kind={server.kind} size={38} />
        <div className="ix-gs__id">
          <p className="ix-gs__name">
            {server.name}
            <span className="ix-gs__state">
              <StatusDot state={server.status.state} />
              <span aria-hidden>{stateLabel(server.status.state)}</span>
            </span>
          </p>
          <p className="ix-gs__addr">
            {server.address} · {gameKindMeta(server.kind).short}
          </p>
        </div>
        <div className="ix-gs__acts">
          {connect && (
            <a href={connect} className="ix-qbtn">
              Connect
            </a>
          )}
          <CopyAddressButton address={server.address} name={server.name} />
        </div>
      </div>
      <p className="ix-gs__detail" data-tone={detail.tone}>
        {detail.text}
      </p>
      {names.length > 0 && (
        <div className="ix-gs__pile">
          <PlayerPile names={names} total={server.status.players_online} max={8} />
        </div>
      )}
    </li>
  );
}
