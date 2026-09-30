import { useRef, useState } from 'react';

import { useDailyWordSettings } from '../../../hooks/useDailyWord';
import { useGameServers } from '../../../hooks/useGameServers';
import { useSportsPolling, useSportsSettings } from '../../../hooks/useSportsBoard';
import { dailyWordHref, isDailyWordPath } from '../../dailyWord/model';
import { CopyAddressButton } from '../../gameServers/GameServerParts';
import { connectUrl, summaryLine, upCount } from '../../gameServers/gameServerModel';
import { isSportsPath, liveCount, sportsHref } from '../../sports/model';
import { Popover } from '../../ui/Popover';
import { GlyphRow, type RowFocus } from './PlaceRows';
import type { GameServer } from '../../../api/gameServers';

/**
 * A server's add-ons as rows (docs/glass-plan.md §1.3: "channel rows with a glyph
 * tile, same 64px row"): Sports, Daily word and Game servers, each only while the
 * server has it on. Same data and same destinations as the Lantern sidebar's
 * rows; they only look like the rest of the list now.
 */

export type AddonRowKind = 'sports' | 'word' | 'games';

export interface AddonModel {
  id: string;
  kind: AddonRowKind;
  name: string;
  line: string | null;
  selected: boolean;
  href?: string;
  servers?: readonly GameServer[];
  guildName?: string;
}

export const ADDON_ID = {
  sports: 'addon:sports',
  word: 'addon:word',
  games: 'addon:games',
} as const;

/** Which add-ons this server has on, with what each row says. */
export function useAddons(guildId: string, guildName: string, pathname: string): AddonModel[] {
  const { settings, board } = useSportsSettings(guildId);
  const sportsOn = settings?.enabled === true;
  // The same 60 second poll the sidebar ran, so the row can say what is live.
  useSportsPolling(guildId, sportsOn, 'sidebar');
  const { enabled: wordOn } = useDailyWordSettings(guildId);
  const { servers } = useGameServers(guildId);

  const models: AddonModel[] = [];
  if (sportsOn) {
    const live = liveCount(board?.games);
    models.push({
      id: ADDON_ID.sports,
      kind: 'sports',
      name: 'Sports',
      line: live > 0 ? `${live} live now` : 'Scores',
      selected: isSportsPath(guildId, pathname),
      href: sportsHref(guildId),
    });
  }
  if (wordOn) {
    models.push({
      id: ADDON_ID.word,
      kind: 'word',
      name: 'Daily word',
      line: "Today's puzzle",
      selected: isDailyWordPath(guildId, pathname),
      href: dailyWordHref(guildId),
    });
  }
  if (servers.length > 0) {
    const checked = servers.some((server) => server.status.state !== 'checking');
    models.push({
      id: ADDON_ID.games,
      kind: 'games',
      name: 'Game servers',
      line: checked ? `${upCount(servers)} of ${servers.length} up` : 'Checking…',
      selected: false,
      servers,
      guildName,
    });
  }
  return models;
}

export interface AddonRowsProps {
  addons: readonly AddonModel[];
  focusOf: (id: string) => RowFocus;
  onOpen: (addon: AddonModel) => void;
}

export function AddonRows({ addons, focusOf, onOpen }: AddonRowsProps) {
  return (
    <>
      {addons.map((addon) =>
        addon.kind === 'games' ? (
          <GameServersRow key={addon.id} addon={addon} focus={focusOf(addon.id)} />
        ) : (
          <GlyphRow
            key={addon.id}
            id={addon.id}
            href={addon.href}
            glyph={addon.kind === 'sports' ? 'trophy' : 'word'}
            name={addon.name}
            line={addon.line}
            selected={addon.selected}
            onOpen={() => onOpen(addon)}
            {...focusOf(addon.id)}
          />
        ),
      )}
    </>
  );
}

/** Game servers open a small popover with each server, rather than a page. */
function GameServersRow({ addon, focus }: { addon: AddonModel; focus: RowFocus }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const servers = addon.servers ?? [];
  return (
    <div className="glass-place-anchor" ref={(node) => { anchor.current = node; }}>
      <GlyphRow
        id={addon.id}
        glyph="games"
        name={addon.name}
        line={addon.line}
        hasPopup="dialog"
        expanded={open}
        onOpen={() => setOpen((current) => !current)}
        {...focus}
      />
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        role="dialog"
        label={`${addon.guildName ?? 'Server'} game servers`}
        side="right"
        align="start"
        className="glass-place-popover"
      >
        <h2 className="glass-place-popover__title">Game servers</h2>
        <ul className="glass-place-popover__list">
          {servers.map((server) => {
            const connect = connectUrl(server);
            return (
              <li key={server.id} className="glass-place-popover__item">
                <span className="glass-place-popover__text">
                  <span className="glass-name">{server.name}</span>
                  <span className="glass-place-popover__line">{summaryLine(server.status)}</span>
                </span>
                {connect && (
                  <a href={connect} className="glass-btn glass-btn--text glass-focusable">
                    Connect
                  </a>
                )}
                <CopyAddressButton address={server.address} name={server.name} />
              </li>
            );
          })}
        </ul>
      </Popover>
    </div>
  );
}
