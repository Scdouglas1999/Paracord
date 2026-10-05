import { clockLabel, dayTile } from '../../glass/cards/eventTime';
import { DRAFT_EVENT_NAME, nextGameNight } from './welcomeModel';

/**
 * "Plan a night" (docs/index-spec.md §4.13, §5.6): the draft event card is a
 * client-only proposal until "Post it". It says "Game night", the next Friday at
 * 9:00 PM local, in the server's first voice channel. Nothing here talks to the
 * server; `useDraftEvent` does that.
 */

export interface DraftVoice {
  id: string;
  name: string;
}

export interface DraftPlan {
  name: string;
  start: Date;
  /** The server's first voice channel (by position), or null when it has none. */
  voice: DraftVoice | null;
  /** Where the action card was, for the card to grow out of (§5.6). Null under test. */
  from: DOMRect | null;
  /** The scheduled event once it exists, so a retry posts the message and never makes a second event. */
  eventId: string | null;
}

interface ChannelLike {
  id: string;
  name?: string | null;
  type?: number;
  channel_type?: number;
  position: number;
  parent_id?: string | null;
}

/**
 * The server's first voice channel in the sidebar's order (uncategorized first, then
 * category order, then position). A stage is not counted: an event is held where
 * people talk.
 */
export function firstVoiceChannel(channels: readonly ChannelLike[]): DraftVoice | null {
  const kind = (channel: ChannelLike) => channel.type ?? channel.channel_type;
  const categories = new Map(channels.filter((channel) => kind(channel) === 4).map((channel) => [channel.id, channel.position]));
  const rank = (channel: ChannelLike) => (channel.parent_id ? (categories.get(channel.parent_id) ?? Number.MAX_SAFE_INTEGER) : -1);
  const voice = channels
    .filter((channel) => kind(channel) === 2)
    .sort((a, b) => rank(a) - rank(b) || a.position - b.position)[0];
  return voice ? { id: voice.id, name: voice.name?.trim() || 'Voice channel' } : null;
}

export function newDraft(now: Date, channels: readonly ChannelLike[], from: DOMRect | null): DraftPlan {
  return {
    name: DRAFT_EVENT_NAME,
    start: nextGameNight(now),
    voice: firstVoiceChannel(channels),
    from,
    eventId: null,
  };
}

const weekdayLong = (date: Date) => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);

/** "Friday at 9:00 PM · in General": the weekday is enough because the tile beside it says which Friday. */
export function draftMeta(plan: Pick<DraftPlan, 'start' | 'voice'>): string {
  const when = `${weekdayLong(plan.start)} at ${clockLabel(plan.start)}`;
  return plan.voice ? `${when} · in ${plan.voice.name}` : when;
}

export function draftTile(plan: Pick<DraftPlan, 'start'>) {
  return dayTile(plan.start);
}

/** The `POST /guilds/:id/events` body: a reminder before it starts (the nudge), held in the voice channel when there is one. */
export function draftPayload(plan: DraftPlan): Record<string, unknown> {
  return {
    name: plan.name,
    scheduled_start: plan.start.toISOString(),
    entity_type: plan.voice ? 1 : 2,
    ...(plan.voice ? { channel_id: plan.voice.id } : null),
    reminder_minutes: 30,
  };
}
