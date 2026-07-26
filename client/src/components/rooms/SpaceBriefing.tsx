import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Bell, BookOpen, Hash, MessageSquare, MoveRight } from 'lucide-react';
import { safeStoredImageDataUrl } from '../../lib/security';
import { ChannelType, type Channel, type HubSettings } from '../../types';

interface SpaceBriefingProps {
  guildId: string;
  settings?: HubSettings;
  channels: Channel[];
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTextDestination(channel: Channel): boolean {
  const type = channel.type ?? channel.channel_type;
  return (
    type === ChannelType.Text ||
    type === ChannelType.Announcement ||
    type === ChannelType.Forum
  );
}

function channelIcon(channel: Channel) {
  const type = channel.type ?? channel.channel_type;
  if (type === ChannelType.Announcement) return Bell;
  if (type === ChannelType.Forum) return MessageSquare;
  return Hash;
}

/**
 * Member-facing consumption of Space Hub settings.
 *
 * Admin-authored welcome copy, banner, and featured channels used to stop at the
 * settings form. Rooms is the canonical space front door, so it now surfaces that
 * context after live rooms: presence stays first, while newcomers still get a clear
 * place to begin. The component disappears when nothing useful is configured.
 */
export function SpaceBriefing({ guildId, settings, channels }: SpaceBriefingProps) {
  const navigate = useNavigate();
  const welcome = textValue(settings?.welcome_text);
  const description = textValue(settings?.description);
  const bannerValue = settings?.banner_hash;
  const bannerSrc =
    typeof bannerValue === 'string' ? safeStoredImageDataUrl(bannerValue) : null;

  const pinnedChannels = useMemo(() => {
    const pinnedIds = Array.isArray(settings?.pinned_channels)
      ? settings.pinned_channels.filter((id): id is string => typeof id === 'string')
      : [];
    if (pinnedIds.length === 0) return [];

    const byId = new Map(
      channels.filter(isTextDestination).map((channel) => [channel.id, channel]),
    );
    return pinnedIds
      .map((id) => byId.get(id))
      .filter((channel): channel is Channel => Boolean(channel));
  }, [channels, settings?.pinned_channels]);

  const hasCopy = Boolean(welcome || description);
  if (!bannerSrc && !hasCopy && pinnedChannels.length === 0) return null;

  return (
    <section aria-label="Start here" className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-section uppercase text-text-muted">
        <BookOpen size={14} className="text-interactive-normal" aria-hidden />
        Start here
      </div>

      <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
        {bannerSrc && (
          <div className="h-28 border-b border-border-subtle bg-bg-tertiary sm:h-36">
            <img
              src={bannerSrc}
              alt=""
              className="h-full w-full object-cover"
            />
          </div>
        )}

        <div
          className={
            hasCopy && pinnedChannels.length > 0
              ? 'grid lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.72fr)]'
              : undefined
          }
        >
          {hasCopy && (
            <div className="px-5 py-5 sm:px-6 sm:py-6">
              <p className="text-section uppercase text-accent-primary">Welcome</p>
              {welcome && (
                <h2 className="mt-1.5 font-display text-subhead text-text-primary sm:text-title">
                  {welcome}
                </h2>
              )}
              {description && (
                <p className="mt-2 max-w-prose whitespace-pre-wrap text-label leading-relaxed text-text-secondary">
                  {description}
                </p>
              )}
            </div>
          )}

          {pinnedChannels.length > 0 && (
            <div className="border-t border-border-subtle px-3 py-3 lg:border-l lg:border-t-0">
              <p className="px-2 pb-1.5 text-section uppercase text-text-muted">
                Featured rooms
              </p>
              <div className="flex flex-col gap-0.5">
                {pinnedChannels.map((channel) => {
                  const Icon = channelIcon(channel);
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() =>
                        navigate(`/app/guilds/${guildId}/channels/${channel.id}`)
                      }
                      className="group flex min-h-10 w-full items-center gap-2 rounded-sm px-2 text-left text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                      aria-label={`Open ${channel.name || 'featured room'}`}
                    >
                      <Icon size={17} className="shrink-0 text-channel-icon" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-label font-semibold">
                          {channel.name || 'unknown'}
                        </span>
                        {channel.topic && (
                          <span className="block truncate text-meta text-text-muted">
                            {channel.topic}
                          </span>
                        )}
                      </span>
                      <MoveRight
                        size={15}
                        className="shrink-0 text-text-muted transition-transform duration-[140ms] ease-[var(--ease-out)] group-hover:translate-x-0.5 group-hover:text-text-primary"
                        aria-hidden
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
