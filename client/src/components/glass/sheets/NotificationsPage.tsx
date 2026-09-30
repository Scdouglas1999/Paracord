import { AtSign, Bell, BellOff, Check, Server } from 'lucide-react';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { useRoomNotifications, type RoomNotificationLevel } from '../../../hooks/useRoomNotifications';
import { entityScopeKey } from '../../../lib/serverScope';
import { SheetEmpty, SheetKicker } from './SheetParts';

/**
 * Notifications for this channel: every message, only when you are mentioned,
 * nothing, or follow the server. The one in force is a checked radio, so the
 * page says what the setting is, not only what it could be (§9). Below it, the
 * server's own switch, since "follow the server" is only a promise until you
 * can see what the server is set to.
 */

const CHOICES: Array<{
  level: RoomNotificationLevel;
  name: string;
  detail: string;
  icon: typeof Bell | null;
}> = [
  { level: 0, name: 'Every message', detail: 'Every new message in this channel notifies you.', icon: Bell },
  { level: 1, name: 'Only when you’re mentioned', detail: 'Only messages that mention you notify you.', icon: AtSign },
  { level: 2, name: 'Nothing from this channel', detail: 'Nothing in this channel notifies you.', icon: BellOff },
  { level: null, name: 'Follow the server', detail: 'Use whatever this server is set to.', icon: null },
];

export function NotificationsPage({ channelId, guildId }: { channelId: string | null; guildId: string | null }) {
  const scope = useCurrentAccountScope();
  const channel = useCurrentChannelStore((s) => (channelId ? s.channelsById[channelId] : undefined));
  const roomNotifications = useRoomNotifications();
  const { mutedGuildKeys, toggleMute, saving } = useMutedGuilds();

  if (!scope || !channelId || !channel) {
    return (
      <SheetEmpty icon={<Bell size={20} />} title="No channel selected">
        Open a channel to choose how it notifies you.
      </SheetEmpty>
    );
  }

  const reference = { id: channelId, scope, name: channel.name ?? undefined };
  const level = roomNotifications.levelOf(reference);
  const busy = roomNotifications.savingRoom(reference);
  const serverKey = guildId ? entityScopeKey(scope, guildId) : null;
  const serverMuted = serverKey ? mutedGuildKeys.includes(serverKey) : false;

  return (
    <div className="glass-sheet-narrow">
      <SheetKicker>This channel</SheetKicker>
      <div role="radiogroup" aria-label="Notifications for this channel" className="glass-sheet-list">
        {CHOICES.map((choice) => {
          const Icon = choice.icon;
          const selected = level === choice.level;
          return (
            <button
              key={choice.name}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              data-selected={selected ? 'true' : undefined}
              className="glass-sheet-row glass-focusable"
              onClick={() => roomNotifications.setLevel(reference, choice.level)}
            >
              <span className="glass-sheet-row__lead" aria-hidden>
                {Icon ? <Icon size={17} /> : <Server size={17} />}
              </span>
              <span className="glass-sheet-row__text">
                <span className="glass-sheet-row__name">{choice.name}</span>
                <span className="glass-sheet-row__detail">{choice.detail}</span>
              </span>
              {selected && <Check size={18} className="glass-sheet-row__check" aria-hidden />}
            </button>
          );
        })}
      </div>

      {guildId && (
        <>
          <SheetKicker>This server</SheetKicker>
          <div className="glass-sheet-list">
            <button
              type="button"
              role="switch"
              aria-checked={serverMuted}
              disabled={serverKey ? (saving[serverKey] ?? false) : true}
              className="glass-sheet-row glass-focusable"
              onClick={() => void toggleMute({ id: guildId, scope })}
            >
              <span className="glass-sheet-row__lead" aria-hidden>
                {serverMuted ? <BellOff size={17} /> : <Bell size={17} />}
              </span>
              <span className="glass-sheet-row__text">
                <span className="glass-sheet-row__name">Mute this server</span>
                <span className="glass-sheet-row__detail">
                  {serverMuted ? 'Muted: this server does not notify you.' : 'Not muted: channels notify by their own setting.'}
                </span>
              </span>
              <span className="glass-sheet-row__aside">{serverMuted ? 'On' : 'Off'}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
