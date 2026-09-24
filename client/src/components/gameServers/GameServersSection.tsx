import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Gamepad2, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { gameServerErrorMessage, gameServersApi, type GameServer } from '../../api/gameServers';
import { useGuildChannels } from '../../hooks/useChannels';
import { GAME_SERVER_REFRESH_MS } from '../../hooks/useGameServers';
import { writeClipboardText } from '../../lib/clipboard';
import { cn } from '../../lib/utils';
import { confirm } from '../../stores/confirmStore';
import { useGameServerStore } from '../../stores/gameServerStore';
import { toast } from '../../stores/toastStore';
import { ChannelType, type Channel } from '../../types';
import { Button, Chip, EmptyState, ErrorBanner, IconButton, LoadingSpinner, Switch, Well } from '../ui';
import { MenuItem, Popover } from '../ui/Popover';
import { GroupLabel } from '../guild/SettingsPrimitives';
import { detailLine, gameKindMeta, stateLabel } from './gameServerModel';
import { GameKindIcon, StatusDot } from './GameServerParts';
import { GameServerSheet } from './GameServerSheet';

export const GAME_SERVERS_DESCRIPTION =
  "Whether your Minecraft or Steam game servers are up and who's on, in the sidebar and on the front page.";

function postableChannels(channels: readonly Channel[]): Channel[] {
  return channels
    .filter((channel) => {
      const type = channel.channel_type ?? channel.type;
      return type === ChannelType.Text || type === ChannelType.Announcement;
    })
    .slice()
    .sort((a, b) => a.position - b.position);
}

/**
 * Server settings → Add-ons → Game servers: the servers this community runs,
 * how each is doing, and "Add a game server".
 */
export function GameServersSection({ guildId }: { guildId: string }) {
  const entry = useGameServerStore((state) => state.byGuild[guildId]);
  const [toggling, setToggling] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<GameServer | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const guildChannels = useGuildChannels(guildId);
  const channels = useMemo(() => postableChannels(guildChannels), [guildChannels]);
  const channelName = useCallback(
    (id: string) => guildChannels.find((channel) => channel.id === id)?.name ?? 'a deleted channel',
    [guildChannels],
  );

  const load = useCallback(async () => {
    await useGameServerStore.getState().refresh(guildId);
    setNow(Date.now());
  }, [guildId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), GAME_SERVER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const data = entry?.list ?? null;
  const loading = !data && (entry?.status ?? 'loading') !== 'error';
  const error = entry?.error ?? null;

  const setEnabled = async (enabled: boolean) => {
    if (!enabled) {
      const ok = await confirm({
        title: 'Turn off Game servers?',
        description: 'The servers stop being checked and leave the sidebar and front page. They stay saved.',
        confirmLabel: 'Turn off',
        cancelLabel: 'Cancel',
        variant: 'danger',
      });
      if (!ok) return;
    }
    setToggling(true);
    try {
      await gameServersApi.setEnabled(guildId, enabled);
      useGameServerStore.getState().setEnabled(guildId, enabled);
      void load();
    } catch (err) {
      toast.error(gameServerErrorMessage(err));
    } finally {
      setToggling(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setSheetOpen(true);
  };

  const openEdit = (server: GameServer) => {
    setEditing(server);
    setSheetOpen(true);
  };

  const onSaved = (server: GameServer) => {
    useGameServerStore.getState().upsert(guildId, server);
    setNow(Date.now());
    toast.success(editing ? `${server.name} saved.` : `${server.name} added.`);
  };

  const copyAddress = async (server: GameServer) => {
    try {
      await writeClipboardText(server.address);
      toast.success(`Copied ${server.address}.`);
    } catch {
      toast.error("Couldn't copy the address.");
    }
  };

  const remove = async (server: GameServer) => {
    const ok = await confirm({
      title: `Remove ${server.name}?`,
      description: 'It stops being checked. Announcements it already posted stay in the channel.',
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await gameServersApi.remove(guildId, server.id);
      useGameServerStore.getState().removeServer(guildId, server.id);
      toast.success(`${server.name} removed.`);
    } catch (err) {
      toast.error(gameServerErrorMessage(err));
    }
  };

  const enabled = data?.enabled ?? false;
  const servers = data?.servers ?? [];
  const limit = data?.limit ?? 10;
  const full = servers.length >= limit;

  return (
    <div className="flex h-full min-h-0 flex-col gap-8 overflow-y-auto pb-6">
      <Well bare className="flex items-start gap-3 px-4 py-4 sm:items-center">
        <span className="pc-addon-mark" aria-hidden>
          <Gamepad2 size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-name font-semibold text-text-primary">Game servers</h3>
            {enabled && <Chip size="sm" tone="accent">On</Chip>}
          </div>
          <p className="mt-0.5 text-body leading-relaxed text-text-secondary">{GAME_SERVERS_DESCRIPTION}</p>
        </div>
        <Switch
          checked={enabled}
          onChange={(next) => void setEnabled(next)}
          disabled={!data || toggling}
          label="Game servers on this server"
          className="mt-1 sm:mt-0"
        />
      </Well>

      {error && <ErrorBanner message={error} multiline onRetry={() => void load()} />}

      {loading ? (
        <LoadingSpinner label="Loading game servers…" className="py-10" />
      ) : !data ? null : !enabled ? (
        <p className="max-w-prose text-body text-text-secondary">
          Turn Game servers on to list your community's servers. Each one is checked every minute, and members see
          who's on without asking in chat.
        </p>
      ) : (
        <section className="flex flex-col gap-3" aria-label="Game servers on this server">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <GroupLabel>Game servers</GroupLabel>
              <span className="text-meta tabular-nums text-text-faint">
                {servers.length} of {limit}
              </span>
            </div>
            {servers.length > 0 && (
              <Button size="sm" variant="primary" onClick={openAdd} disabled={full}>
                <Plus size={14} aria-hidden />
                Add a game server
              </Button>
            )}
          </div>
          {full && (
            <p className="text-meta text-text-muted">
              This server lists {limit} game servers, the most it can. Remove one to add another.
            </p>
          )}
          {servers.length === 0 ? (
            <EmptyState
              icon={<Gamepad2 size={18} />}
              title="No game servers yet"
              description="Add a Minecraft server, a Steam game server like Counter-Strike 2 or Valheim, or any game's port. Members see who's on in the sidebar."
              action={
                <Button variant="primary" onClick={openAdd}>
                  <Plus size={16} aria-hidden />
                  Add a game server
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {servers.map((server) => (
                <GameServerRow
                  key={server.id}
                  server={server}
                  channel={server.announce_channel_id ? channelName(server.announce_channel_id) : null}
                  now={now}
                  onEdit={() => openEdit(server)}
                  onCopy={() => void copyAddress(server)}
                  onRemove={() => void remove(server)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <GameServerSheet
        guildId={guildId}
        open={sheetOpen}
        editing={editing}
        onClose={() => setSheetOpen(false)}
        channels={channels}
        onSaved={onSaved}
      />
    </div>
  );
}

function GameServerRow({
  server,
  channel,
  now,
  onEdit,
  onCopy,
  onRemove,
}: {
  server: GameServer;
  channel: string | null;
  now: number;
  onEdit: () => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const detail = detailLine(server.status, now);
  const close = () => setMenuOpen(false);
  const act = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <li className="pc-feed-row flex items-start gap-3 py-3">
      <GameKindIcon kind={server.kind} size={36} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-label font-semibold text-text-primary">{server.name}</span>
          <span className="flex shrink-0 items-center gap-1.5 text-meta text-text-secondary">
            <StatusDot state={server.status.state} />
            <span aria-hidden>{stateLabel(server.status.state)}</span>
          </span>
        </div>
        <p className="mt-0.5 truncate text-meta text-text-muted">
          {server.address} · {gameKindMeta(server.kind).short}
          {channel ? ` · announces in #${channel}` : ''}
        </p>
        <p
          className={cn(
            'mt-1 text-meta leading-relaxed',
            detail.tone === 'error' ? 'text-accent-danger' : detail.tone === 'muted' ? 'text-text-muted' : 'text-text-secondary',
          )}
        >
          {detail.text}
        </p>
        {server.announce_error && (
          <p className="mt-1 text-meta leading-relaxed text-accent-warning">{server.announce_error}</p>
        )}
      </div>
      <IconButton
        ref={anchor}
        label={`Options for ${server.name}`}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreHorizontal size={16} />
      </IconButton>
      <Popover
        anchor={anchor}
        open={menuOpen}
        onClose={close}
        role="menu"
        label={`${server.name} options`}
        side="bottom"
        align="end"
        className="w-56 p-1"
      >
        <MenuItem icon={<Pencil size={14} />} onClick={act(onEdit)}>
          Edit
        </MenuItem>
        <MenuItem icon={<Copy size={14} />} onClick={act(onCopy)}>
          Copy address
        </MenuItem>
        <MenuItem icon={<Trash2 size={14} />} danger onClick={act(onRemove)}>
          Remove
        </MenuItem>
      </Popover>
    </li>
  );
}
