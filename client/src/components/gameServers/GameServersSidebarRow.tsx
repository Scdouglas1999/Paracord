import { useId, useRef, useState } from 'react';
import { Gamepad2 } from 'lucide-react';
import type { GameServer } from '../../api/gameServers';
import { useMobile } from '../../hooks/useMobile';
import { Chip, NavRow } from '../ui';
import { Popover } from '../ui/Popover';
import { connectUrl, summaryLine, upCount } from './gameServerModel';
import { CopyAddressButton, StatusDot } from './GameServerParts';

/**
 * "Game servers" under a server's plate, while the add-on is on and lists at
 * least one: how many are up, and a popover with each one.
 */
export function GameServersSidebarRow({ guildName, servers }: { guildName: string; servers: readonly GameServer[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement>(null);
  const titleId = useId();
  // Beside the column on a desktop; under the row on a phone, where the
  // column fills the screen and there is nothing beside it.
  const phone = useMobile();
  const up = upCount(servers);
  const checked = servers.some((server) => server.status.state !== 'checking');

  return (
    <>
      <NavRow
        ref={anchor}
        role="option"
        aria-selected={false}
        aria-haspopup="dialog"
        aria-expanded={open}
        tabIndex={-1}
        icon={<Gamepad2 size={16} />}
        onClick={() => setOpen((current) => !current)}
        trailing={
          checked ? (
            <Chip size="sm" aria-label={`${up} of ${servers.length} up`}>
              <StatusDot state={up > 0 ? 'up' : 'down'} className="h-1.5 w-1.5" />
              {up} up
            </Chip>
          ) : null
        }
      >
        Game servers
      </NavRow>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        role="dialog"
        label={`${guildName} game servers`}
        side={phone ? 'bottom' : 'right'}
        align={phone ? 'end' : 'start'}
        className="w-[min(20rem,calc(100vw-16px))] p-1.5"
      >
        <h2 id={titleId} className="px-2.5 pb-1 pt-1.5 text-meta font-semibold text-text-muted">
          Game servers
        </h2>
        <ul aria-labelledby={titleId} className="flex flex-col">
          {servers.map((server) => (
            <GameServerLine key={server.id} server={server} />
          ))}
        </ul>
      </Popover>
    </>
  );
}

function GameServerLine({ server }: { server: GameServer }) {
  const connect = connectUrl(server);
  return (
    <li className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2">
      <StatusDot state={server.status.state} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label font-semibold text-text-primary">{server.name}</p>
        <p className="truncate text-meta text-text-muted">{summaryLine(server.status)}</p>
      </div>
      {connect && (
        <a
          href={connect}
          className="pc-focusable pc-pressable inline-flex h-[var(--h-control-sm)] shrink-0 items-center rounded-[var(--radius-control)] bg-bg-raised px-2.5 text-meta font-semibold text-text-primary shadow-[var(--shadow-raised)] hover:bg-bg-mod-strong"
        >
          Connect
        </a>
      )}
      <CopyAddressButton address={server.address} name={server.name} />
    </li>
  );
}
