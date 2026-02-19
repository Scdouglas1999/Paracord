import { Hash, Volume2, MessageSquare, Users, X } from 'lucide-react';
import type { Guild, Channel } from '../../types';

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

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg-tertiary/75 p-4 backdrop-blur-sm">
      <div className="glass-modal relative w-full max-w-lg rounded-2xl border border-border-subtle p-6 sm:p-8">
        {/* Close button */}
        <button
          onClick={onDismiss}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
          aria-label="Close welcome screen"
        >
          <X size={18} />
        </button>

        {/* Guild icon + name */}
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle text-2xl font-bold text-text-primary">
            {guild.icon_hash ? (
              <img
                src={`/api/guilds/${guild.id}/icon`}
                alt={guild.name}
                className="h-full w-full rounded-2xl object-cover"
              />
            ) : (
              guild.name.charAt(0).toUpperCase()
            )}
          </div>

          <h2 className="text-xl font-bold text-text-primary">
            Welcome to {guild.name}!
          </h2>

          {guild.description && (
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
              {guild.description}
            </p>
          )}

          {/* Member count */}
          <div className="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
            <Users size={13} />
            <span>{guild.member_count} member{guild.member_count !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Channel overview */}
        {textChannels.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              Channels
            </h3>
            <div className="max-h-48 space-y-0.5 overflow-y-auto scrollbar-thin">
              {Array.from(categories.entries()).map(([catId, cat]) => (
                <div key={catId || '__uncategorized'}>
                  {catId && (
                    <div className="mt-2 mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                      {cat.name}
                    </div>
                  )}
                  {cat.channels.slice(0, 8).map(ch => {
                    const isVoice = ch.type === 2 || ch.channel_type === 2;
                    const isForum = ch.type === 7 || ch.channel_type === 7;
                    return (
                      <div
                        key={ch.id}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-secondary"
                      >
                        {isVoice ? (
                          <Volume2 size={14} className="shrink-0 text-text-muted" />
                        ) : isForum ? (
                          <MessageSquare size={14} className="shrink-0 text-text-muted" />
                        ) : (
                          <Hash size={14} className="shrink-0 text-text-muted" />
                        )}
                        <span className="truncate font-medium">{ch.name || 'unknown'}</span>
                        {ch.topic && (
                          <span className="ml-auto truncate text-xs text-text-muted max-w-[140px]">
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

        {/* Start Chatting button */}
        <div className="mt-6 flex justify-center">
          <button
            onClick={onDismiss}
            className="btn-primary px-8"
          >
            Start Chatting
          </button>
        </div>
      </div>
    </div>
  );
}
