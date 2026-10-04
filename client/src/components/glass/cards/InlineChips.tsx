import { useInRouterContext, useNavigate } from 'react-router';

import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType } from '../../../types';
import { IxGlyph } from '../../ix/glyphs/IxGlyph';
import { chipWhen, planWhen } from './eventTime';
import { isHappeningNow, useGuildEvent, type GuildEventView } from './useGuildEvent';
import { useMinuteNow } from './useNow';

/**
 * Chips that sit inside a sentence (docs/index-spec.md §8.4), drawn where
 * `lib/markdown.ts` meets a reference in a message:
 *
 *   <#2002>    a channel. A room with people in it is the live chip (amber tint,
 *              amber dot, "Lounge  3 in"); every other channel is a quiet chip with
 *              just its name (`--ix-fill`, ink 600). Never a `#`.
 *   <event:1>  an event: calendar glyph, its name and a short time (`--ix-card`).
 *
 * Solid fills, no outlines. The inks are Index's own, never the bubble's, because
 * a chip inside YOUR cream bubble sits on the light bubble: there the fills turn
 * to a wash of dark ink (`ix-cards.css`).
 */

const isVoiceLike = (type: number | undefined) => type === ChannelType.Voice || type === ChannelType.Stage;

/** The channel chip's own look, for a place with no stores to read (a gallery) and for the stores' chip below. */
export function ChannelChipView({
  name,
  inside = 0,
  onOpen,
  missing,
}: {
  name: string;
  /** How many are in it, for a room. Above zero it is the live chip. */
  inside?: number;
  /** Makes it a button (a routed chip). */
  onOpen?: () => void;
  /** A channel this account cannot see, or one that is gone. */
  missing?: boolean;
}) {
  const live = inside > 0;
  const className = live ? 'ix-inline ix-inline--live' : 'ix-inline ix-inline--channel';
  const body = live ? (
    <>
      <span className="ix-inline__dot" aria-hidden />
      {name}
      <span className="ix-inline__aside">{inside} in</span>
    </>
  ) : (
    name
  );
  if (missing) {
    return (
      <span className="ix-inline ix-inline--channel" data-missing>
        {name}
      </span>
    );
  }
  if (!onOpen) return <span className={className}>{body}</span>;
  return (
    <button
      type="button"
      className={className}
      data-live={live || undefined}
      aria-label={live ? `${name}, ${inside} in it now` : name}
      title={live ? `${name}: ${inside} in it now` : name}
      onClick={onOpen}
    >
      {body}
    </button>
  );
}

function RoutedChannelChip({ guildId, channelId, name, inside }: { guildId: string; channelId: string; name: string; inside: number }) {
  const navigate = useNavigate();
  return (
    <ChannelChipView
      name={name}
      inside={inside}
      onOpen={() => navigate(`/app/guilds/${guildId}/channels/${channelId}`)}
    />
  );
}

/** A channel mentioned in a message. `guildId` is the conversation's server. */
export function ChannelMentionChip({ channelId }: { channelId: string }) {
  const channel = useCurrentChannelStore((view) => view.channelsById[channelId]);
  const type = channel?.type ?? channel?.channel_type;
  const inside = useVoiceStore((state) => (isVoiceLike(type) ? state.channelParticipants.get(channelId)?.length ?? 0 : 0));
  const inRouter = useInRouterContext();

  // A channel this account cannot see, or one that is gone: say so quietly.
  if (!channel) return <ChannelChipView name="a channel" missing />;
  const name = channel.name?.trim() || 'a channel';
  if (!inRouter || !channel.guild_id) return <ChannelChipView name={name} inside={inside} />;
  return <RoutedChannelChip guildId={channel.guild_id} channelId={channelId} name={name} inside={inside} />;
}

/** The event chip's own look: "Movie night  Fri 9 PM". */
export function EventChipView({ name, aside, title }: { name: string; aside: string; title?: string }) {
  return (
    <span className="ix-inline ix-inline--event" title={title}>
      <IxGlyph name="plan" size={14} />
      {name}
      <span className="ix-inline__aside">{aside}</span>
    </span>
  );
}

/** An event the chip names, from a view the stores gave. */
export function eventChipParts(event: GuildEventView, nowMs: number): { aside: string; title: string } {
  const happening = isHappeningNow(event, nowMs);
  return {
    aside: happening ? 'now' : chipWhen(event.startsAt, nowMs),
    title: `${event.name}: ${planWhen(event.startsAt, { nowMs, endsAt: event.endsAt, happeningNow: happening })}`,
  };
}

/** An event mentioned in a message: "Movie night  Fri 9 PM". */
export function EventChip({ guildId, eventId }: { guildId: string | null | undefined; eventId: string }) {
  const { status, event } = useGuildEvent(guildId, eventId);
  const nowMs = useMinuteNow();

  if (!event) {
    return (
      <span className="ix-inline ix-inline--channel" data-missing>
        {status === 'loading' ? 'an event' : 'an event that is gone'}
      </span>
    );
  }
  const { aside, title } = eventChipParts(event, nowMs);
  return <EventChipView name={event.name} aside={aside} title={title} />;
}
