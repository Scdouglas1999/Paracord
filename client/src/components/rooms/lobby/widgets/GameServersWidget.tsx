import { useGameServers } from '../../../../hooks/useGameServers';
import { summaryLine } from '../../../gameServers/gameServerModel';
import { CopyAddressButton, PlayerPile, StatusDot } from '../../../gameServers/GameServerParts';
import { WidgetCard, WidgetError } from './WidgetCard';

/**
 * "Game servers": each of the server's game servers, up or down, how many are
 * on, and who, when the game says. Only while the add-on is on and lists one.
 */
export function GameServersWidget({ guildId }: { guildId: string }) {
  const { list, servers, error } = useGameServers(guildId);
  if (!list?.enabled || servers.length === 0) return null;

  return (
    <WidgetCard title="Game servers">
      {error && <WidgetError>{error}</WidgetError>}
      <ul className="ix-wlist">
        {servers.map((server) => {
          const names = server.status.state === 'up' ? server.status.player_names ?? [] : [];
          return (
            <li key={server.id} className="ix-wserver">
              <div className="ix-row">
                <StatusDot state={server.status.state} />
                <div className="ix-row__body">
                  <p className="ix-row__name">{server.name}</p>
                  <p className="ix-row__line">{summaryLine(server.status)}</p>
                </div>
                <CopyAddressButton address={server.address} name={server.name} />
              </div>
              {names.length > 0 && (
                <div className="ix-wserver__pile">
                  <PlayerPile names={names} total={server.status.players_online} max={6} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </WidgetCard>
  );
}
