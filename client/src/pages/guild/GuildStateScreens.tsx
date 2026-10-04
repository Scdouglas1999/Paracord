import { useNavigate } from 'react-router';

import { EmptyPage } from '../../components/ix/page/EmptyPage';
import { CreamButton } from '../../components/ix/primitives';
import { serverPlace, usePlaceHue } from '../../components/ix/shell';
import { useGuildChannels } from '../../hooks/useChannels';
import { useGuild } from '../../hooks/useGuilds';
import { ChannelType, type Channel } from '../../types';

/**
 * The three states of a channel route that has no conversation to draw yet
 * (docs/index-spec.md §6.8): loading, not found or not yours, and could not load.
 * They fill main, where the conversation will be: a skeleton in its own geometry,
 * and two notices in the empty-state layout (`EmptyPage`: a mark, a title, a line
 * and one cream action).
 */

function typeOf(channel: Channel): number | undefined {
  return channel.type ?? channel.channel_type;
}

/**
 * The channel "Go to general" means: the server's default channel when it still
 * exists, else the first text channel in sidebar order, else the first
 * announcement channel. Null when the server has nothing to read yet.
 */
export function landingChannel(channels: readonly Channel[], defaultChannelId?: string | null): Channel | null {
  const inOrder = [...channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const readable = (channel: Channel) => typeOf(channel) === ChannelType.Text || typeOf(channel) === ChannelType.Announcement;
  return (
    inOrder.find((channel) => channel.id === defaultChannelId && readable(channel)) ??
    inOrder.find((channel) => typeOf(channel) === ChannelType.Text) ??
    inOrder.find(readable) ??
    null
  );
}

/**
 * One group of bubbles in the timeline's own geometry: a 30px face at the group's
 * foot, 19px bubbles joined on the face's side. Widths are the share of the column
 * the bubble fills; yours mirror it on the right with no face.
 */
function SkeletonGroup({ widths, own = false }: { widths: readonly number[]; own?: boolean }) {
  return (
    <div className="ix-skeleton__group" data-own={own || undefined}>
      {!own && <span className="ix-skeleton__face" />}
      <div className="ix-skeleton__bubbles">
        {widths.map((width, index) => (
          <span key={index} className="ix-skeleton__bubble" style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * Loading: a skeleton of the conversation it becomes (the large title, three
 * groups of bubbles, the message box), never a bare spinner. Static: nothing
 * shimmers or pulses (§1.2, §4.11); it reads as one polite status.
 */
export function GuildLoadingScreen() {
  return (
    <div className="ix-skeleton" role="status" aria-busy="true" data-testid="ix-loading">
      <div className="ix-skeleton__head" aria-hidden="true">
        <span className="ix-skeleton__title" />
        <span className="ix-skeleton__sub" />
      </div>
      <div className="ix-skeleton__feed" aria-hidden="true">
        <SkeletonGroup widths={[46]} />
        <SkeletonGroup widths={[62, 38]} />
        <SkeletonGroup widths={[34]} own />
        <SkeletonGroup widths={[54, 70, 28]} />
      </div>
      <div className="ix-skeleton__box" aria-hidden="true" />
      <span className="sr-only">Loading channels...</span>
    </div>
  );
}

/**
 * No-channel / no-access state: one specific line and a way back. Covers both
 * "deleted" and "you can't see this" without leaking which. The way back is the
 * server's own landing channel ("Go to general").
 */
export function ChannelNotFoundScreen({ guildId }: { guildId: string | undefined }) {
  const navigate = useNavigate();
  const channels = useGuildChannels(guildId);
  const guild = useGuild(guildId);
  const hue = usePlaceHue(serverPlace(guildId ?? ''));
  const landing = guildId ? landingChannel(channels, guild?.default_channel_id) : null;

  return (
    <EmptyPage
      glyph="hello"
      hue={guildId ? hue : undefined}
      aria-label="Channel not found"
      title="This channel is gone"
      line="It may have been deleted, or you might not have permission to see it."
      action={
        guildId ? (
          <CreamButton
            onClick={() =>
              navigate(landing ? `/app/guilds/${guildId}/channels/${landing.id}` : `/app/guilds/${guildId}`)
            }
          >
            {landing ? `Go to ${landing.name}` : 'Open the server'}
          </CreamButton>
        ) : undefined
      }
    />
  );
}

export function ChannelLoadErrorScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <EmptyPage
      glyph="x"
      role="alert"
      aria-label="Channels unavailable"
      title="Couldn't load channels"
      line={error}
      action={<CreamButton onClick={onRetry}>Try again</CreamButton>}
    />
  );
}
