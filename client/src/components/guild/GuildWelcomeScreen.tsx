import { Hash, Volume2, MessageSquare, Users, Compass, X } from 'lucide-react';
import type { Guild, Channel } from '../../types';
import { safeStoredImageDataUrl } from '../../lib/security';
import { Button } from '../ui/Button';

interface GuildWelcomeScreenProps {
  guild: Guild;
  channels: Channel[];
  onDismiss: () => void;
}

export function GuildWelcomeScreen({ guild, channels, onDismiss }: GuildWelcomeScreenProps) {
  // Group channels by category
  const categories = new Map<string | null, { name: string; channels: Channel[] }>();
  const categoryNames = new Map<string, string>();

  for (const ch of channels) {
    if (ch.type === 4) {
      categoryNames.set(ch.id, ch.name || 'Unknown');
    }
  }

  for (const ch of channels) {
    if (ch.type === 4) continue; // skip category channels themselves
    const parentId = ch.parent_id || null;
    if (!categories.has(parentId)) {
      categories.set(parentId, {
        name: parentId ? categoryNames.get(parentId) || 'Other' : 'Channels',
        channels: [],
      });
    }
    categories.get(parentId)!.channels.push(ch);
  }

  // Sort channels within each category by position
  for (const cat of categories.values()) {
    cat.channels.sort((a, b) => a.position - b.position);
  }

  const textChannels = channels.filter(ch => ch.type === 0 || ch.channel_type === 0);
  const iconSrc = safeStoredImageDataUrl(guild.icon_hash);

  const gettingStarted = [
    {
      icon: Users,
      title: 'Meet the members',
      body:
        guild.member_count === 1
          ? "You're first through the door — invite a few friends to get things going."
          : `${guild.member_count} people are already here. Say hi when you're ready.`,
    },
    {
      icon: Compass,
      title: 'Find your channels',
      body:
        textChannels.length > 0
          ? `${textChannels.length} ${textChannels.length === 1 ? 'channel is' : 'channels are'} waiting below — each one is a different conversation.`
          : 'Channels will show up here as the space takes shape.',
    },
    {
      icon: MessageSquare,
      title: 'Break the ice',
      body: 'A first message goes a long way. Drop a hello and settle in.',
    },
  ];

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg-tertiary/75 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg border border-border-strong bg-bg-accent shadow-xl">
        {/* Close button */}
        <button
          onClick={onDismiss}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          aria-label="Close welcome screen"
        >
          <X size={18} />
        </button>

        {/* Solid raised header — not a gradient hero */}
        <div className="border-b border-border-subtle bg-bg-secondary px-6 pb-6 pt-7">
          <div className="flex items-start gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-bg-mod-subtle font-display text-2xl font-bold text-text-primary shadow-sm">
              {iconSrc ? (
                <img
                  src={iconSrc}
                  alt={guild.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                guild.name.charAt(0).toUpperCase()
              )}
            </div>
            <div className="min-w-0 pt-0.5">
              <div className="text-section uppercase text-accent-primary">Welcome aboard</div>
              <h2 className="mt-1 font-display text-title text-text-primary">
                {guild.name}
              </h2>
              {guild.description ? (
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                  {guild.description}
                </p>
              ) : (
                <p className="mt-1.5 flex items-center gap-1.5 text-meta text-text-muted">
                  <Users size={13} className="shrink-0" />
                  {guild.member_count} member{guild.member_count !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-5">
          {/* Getting-started rows */}
          <div className="text-section uppercase text-text-muted">Get started</div>
          <div className="mt-2 divide-y divide-border-subtle">
            {gettingStarted.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex items-start gap-3 py-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
                  <Icon size={16} />
                </div>
                <div className="min-w-0">
                  <div className="text-label text-text-primary">{title}</div>
                  <p className="mt-0.5 text-meta leading-relaxed text-text-secondary">{body}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Channel overview */}
          {textChannels.length > 0 && (
            <div className="mt-5">
              <div className="text-section uppercase text-text-muted">Explore channels</div>
              <div className="scrollbar-thin mt-2 max-h-44 space-y-0.5 overflow-y-auto">
                {Array.from(categories.entries()).map(([catId, cat]) => (
                  <div key={catId || '__uncategorized'}>
                    {catId && (
                      <div className="mb-0.5 mt-2 px-2 text-section uppercase text-text-muted">
                        {cat.name}
                      </div>
                    )}
                    {cat.channels.slice(0, 8).map(ch => {
                      const isVoice = ch.type === 2 || ch.channel_type === 2;
                      const isForum = ch.type === 7 || ch.channel_type === 7;
                      return (
                        <div
                          key={ch.id}
                          className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text-secondary"
                        >
                          {isVoice ? (
                            <Volume2 size={16} className="shrink-0 text-channel-icon" />
                          ) : isForum ? (
                            <MessageSquare size={16} className="shrink-0 text-channel-icon" />
                          ) : (
                            <Hash size={16} className="shrink-0 text-channel-icon" />
                          )}
                          <span className="truncate font-medium">{ch.name || 'unknown'}</span>
                          {ch.topic && (
                            <span className="ml-auto max-w-[140px] truncate text-meta text-text-muted">
                              {ch.topic}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer action */}
        <div className="flex items-center justify-end gap-3 border-t border-border-subtle bg-bg-secondary px-6 py-4">
          <Button onClick={onDismiss} size="lg">
            Jump in
          </Button>
        </div>
      </div>
    </div>
  );
}
