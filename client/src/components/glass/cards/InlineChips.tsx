import { useInRouterContext, useNavigate } from 'react-router';

import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType } from '../../../types';
import { CalendarMark } from './CardGlyphs';
import { chipWhen, planWhen } from './eventTime';
import { isHappeningNow, useGuildEvent } from './useGuildEvent';
import { useMinuteNow } from './useNow';

/**
 * Chips that sit inside a sentence (docs/glass-spec.md §3.2), drawn where
 * `lib/markdown.ts` meets a reference in a message:
 *
 *   <#2002>    a channel. A voice channel with people in it is the live chip
 *              (amber tint, amber dot, "Lounge  3 in"); every other channel is
 *              a quiet chip with just its name. Never a `#`.
 *   <event:1>  an event: calendar glyph, its name and a short time.
 *
 * Solid fills, no outlines: content is solid. Their inks come from
 * `--card-ink-*` (glass-cards.css), not `--ink-*`, because a chip inside YOUR
 * bubble sits on the light bubble while keeping its own dark fill.
 */

const isVoiceLike = (type: number | undefined) => type === ChannelType.Voice || type === ChannelType.Stage;

function ChannelChipBody({ name, inside }: { name: string; inside: number }) {
  if (inside > 0) {
    return (
      <>
        <span className="glass-chip__dot" aria-hidden />
        {name}
        <span className="glass-inline-chip__aside">{inside} in</span>
      </>
    );
  }
  return <>{name}</>;
}

function RoutedChannelChip({ guildId, channelId, name, inside }: { guildId: string; channelId: string; name: string; inside: number }) {
  const navigate = useNavigate();
  const live = inside > 0;
  return (
    <button
      type="button"
      className={live ? 'glass-chip glass-chip--live glass-inline-chip' : 'glass-inline-chip glass-inline-chip--channel'}
      data-live={live || undefined}
      aria-label={live ? `${name}, ${inside} in it now` : name}
      title={live ? `${name}: ${inside} in it now` : name}
      onClick={() => navigate(`/app/guilds/${guildId}/channels/${channelId}`)}
    >
      <ChannelChipBody name={name} inside={inside} />
    </button>
  );
}

/** A channel mentioned in a message. `guildId` is the conversation's server. */
export function ChannelMentionChip({ channelId }: { channelId: string }) {
  const channel = useCurrentChannelStore((view) => view.channelsById[channelId]);
  const type = channel?.type ?? channel?.channel_type;
  const inside = useVoiceStore((state) => (isVoiceLike(type) ? state.channelParticipants.get(channelId)?.length ?? 0 : 0));
  const inRouter = useInRouterContext();

  // A channel this account cannot see, or one that is gone: say so quietly.
  if (!channel) {
    return <span className="glass-inline-chip glass-inline-chip--channel" data-missing>a channel</span>;
  }
  const name = channel.name?.trim() || 'a channel';
  if (!inRouter || !channel.guild_id) {
    return (
      <span
        className={inside > 0 ? 'glass-chip glass-chip--live glass-inline-chip' : 'glass-inline-chip glass-inline-chip--channel'}
      >
        <ChannelChipBody name={name} inside={inside} />
      </span>
    );
  }
  return <RoutedChannelChip guildId={channel.guild_id} channelId={channelId} name={name} inside={inside} />;
}

/** An event mentioned in a message: "Movie night  Fri 9 PM". */
export function EventChip({ guildId, eventId }: { guildId: string | null | undefined; eventId: string }) {
  const { status, event } = useGuildEvent(guildId, eventId);
  const nowMs = useMinuteNow();

  if (!event) {
    return (
      <span className="glass-inline-chip glass-inline-chip--channel" data-missing>
        {status === 'loading' ? 'an event' : 'an event that is gone'}
      </span>
    );
  }
  const happening = isHappeningNow(event, nowMs);
  return (
    <span
      className="glass-chip glass-chip--event glass-inline-chip"
      title={`${event.name}: ${planWhen(event.startsAt, { nowMs, endsAt: event.endsAt, happeningNow: happening })}`}
    >
      <CalendarMark />
      {event.name}
      <span className="glass-inline-chip__aside">{happening ? 'now' : chipWhen(event.startsAt, nowMs)}</span>
    </span>
  );
}
