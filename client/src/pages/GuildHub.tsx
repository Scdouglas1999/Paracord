import { useParams, useNavigate } from 'react-router-dom';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { useVoiceStore } from '../stores/voiceStore';
import { Hash, Volume2, MessageSquare, Plus } from 'lucide-react';
import { cn } from '../lib/utils';
import { getGuildColor } from '../lib/colors';
import { Tooltip } from '../components/ui/Tooltip';
import { useEffect } from 'react';
import { safeStoredImageDataUrl } from '../lib/security';
import type { Channel } from '../types';

const EMPTY_CHANNELS: Channel[] = [];

function isChannel(channel: Channel | undefined): channel is Channel {
    return Boolean(channel);
}

function formatGuildServerHost(serverUrl: string | null | undefined): string | null {
    const raw = serverUrl?.trim();
    if (!raw) {
        return null;
    }

    try {
        return new URL(raw).host;
    } catch {
        // Some local/self-hosted guild payloads store host:port without a scheme.
    }

    try {
        return new URL(`http://${raw}`).host;
    } catch {
        return raw;
    }
}

export function GuildHub() {
    const { guildId } = useParams();
    const navigate = useNavigate();
    const guilds = useGuildStore((s) => s.guilds);
    const channels = useChannelStore((s) => s.channelsByGuild[guildId || ''] ?? EMPTY_CHANNELS);
    const fetchChannels = useChannelStore((s) => s.fetchChannels);
    const channelParticipants = useVoiceStore((s) => s.channelParticipants);

    const guild = guilds.find((g) => g.id === guildId);

    useEffect(() => {
        if (guildId && channels.length === 0) {
            void fetchChannels(guildId);
        }
    }, [guildId, channels.length, fetchChannels]);

    if (!guild) {
        return (
            <div
                role="status"
                aria-label="Loading server hub"
                className="flex h-full flex-col overflow-hidden rounded-2xl bg-bg-primary"
            >
                <div className="h-[160px] shrink-0 animate-pulse bg-bg-mod-subtle/60 sm:h-[180px] md:h-[200px]" />
                <div className="grid flex-1 grid-cols-1 gap-5 p-5 sm:gap-6 sm:p-6 lg:p-8 xl:grid-cols-[2fr_1fr]">
                    <div className="flex flex-col gap-4">
                        <div className="h-5 w-40 animate-pulse rounded-md bg-bg-mod-subtle/60" />
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {Array.from({ length: 2 }, (_, i) => (
                                <div key={i} className="h-40 animate-pulse rounded-[16px] border border-border-subtle bg-bg-mod-subtle/40" />
                            ))}
                        </div>
                    </div>
                    <div className="h-48 animate-pulse rounded-[16px] border border-border-subtle bg-bg-mod-subtle/40" />
                </div>
                <span className="sr-only">Loading server hub…</span>
            </div>
        );
    }

    const voiceChannels = channels.filter((c) => c.type === 2);
    const activeVoiceChannels = voiceChannels.filter((c) => (channelParticipants.get(c.id) || []).length > 0);
    const displayVoiceChannels = activeVoiceChannels.length > 0 ? activeVoiceChannels : voiceChannels.slice(0, 2);

    const textChannels = channels.filter((c) => c.type === 0);
    const pinnedChannelIds = guild.hub_settings?.pinned_channels || [];

    const displayThreads: Channel[] = pinnedChannelIds.length > 0
        ? pinnedChannelIds.map((id: string) => textChannels.find((c) => c.id === id)).filter(isChannel)
        : textChannels.slice(0, 3);

    const guildColor = getGuildColor(guild.id);
    const bannerSrc = safeStoredImageDataUrl(guild.hub_settings?.banner_hash);
    const guildServerHost = formatGuildServerHost(guild.server_url);

    return (
        <div className="flex h-full flex-col overflow-y-auto scrollbar-thin rounded-2xl bg-bg-primary">
            {/* Dynamic Banner based on guild color or custom image */}
            <div
                className="relative h-[160px] shrink-0 overflow-hidden sm:h-[180px] md:h-[200px]"
                style={{ backgroundColor: 'var(--bg-primary)' }}
            >
                {bannerSrc ? (
                    <div className="absolute inset-0">
                        <img
                            src={bannerSrc}
                            alt="Server Banner"
                            className="h-full w-full object-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-bg-primary via-bg-primary/40 to-transparent" />
                    </div>
                ) : (
                    <div
                        className="absolute inset-0"
                        style={{ background: `linear-gradient(135deg, ${guildColor}40 0%, var(--bg-primary) 100%)` }}
                    />
                )}

                <div className="absolute bottom-5 left-5 right-5 sm:bottom-6 sm:left-8 sm:right-8 z-10">
                    <h1 className="truncate text-2xl font-extrabold leading-tight tracking-tight text-text-primary drop-shadow-md sm:text-3xl">
                        {guild.hub_settings?.welcome_text || `Welcome to ${guild.name}`}
                    </h1>
                    <p className="mt-1 line-clamp-2 max-w-xl text-sm font-medium leading-normal text-text-secondary sm:mt-2 sm:text-base">
                        {guild.hub_settings?.description || (guildServerHost ? `Federated server on ${guildServerHost}. Jump into an active voice channel or catch up on the latest discussions.` : 'Local community server. Jump into an active voice channel or catch up on the latest discussions.')}
                    </p>
                </div>
            </div>

            <div className="grid flex-1 grid-cols-1 gap-5 p-5 sm:gap-6 sm:p-6 lg:p-8 xl:grid-cols-[2fr_1fr] xl:items-start">
                <div className="flex flex-col gap-8">
                    {/* Active Voice */}
                    <section>
                        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold leading-snug text-text-primary">
                            <Volume2 className="text-accent-success" size={20} />
                            Happening Now
                        </h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {displayVoiceChannels.length > 0 ? (
                                displayVoiceChannels.map((vc) => {
                                    const participants = channelParticipants.get(vc.id) || [];
                                    const displayParticipants = participants.slice(0, 4);
                                    const overflow = participants.length > 4 ? participants.length - 4 : 0;

                                    return (
                                        <div
                                            key={vc.id}
                                            className="group flex flex-col gap-3 rounded-[16px] border border-border-subtle bg-bg-mod-subtle p-5 transition-all hover:border-border-strong hover:bg-bg-mod-strong"
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2 font-semibold text-text-primary">
                                                    <Volume2 size={16} className="text-text-muted" />
                                                    {vc.name}
                                                </div>
                                                <span className="text-[13px] font-medium text-text-muted">
                                                    {participants.length} Active
                                                </span>
                                            </div>

                                            <div className="mt-2 flex items-center">
                                                {displayParticipants.length > 0 ? (
                                                    displayParticipants.map((p, i: number) => (
                                                        <Tooltip key={p.user_id} content={p.username || p.user_id} side="top">
                                                            <div
                                                                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-bg-mod-subtle bg-accent-primary text-[11px] font-bold text-text-on-accent transition-transform group-hover:scale-105"
                                                                style={{ marginLeft: i > 0 ? '-8px' : '0' }}
                                                            >
                                                                {(p.username || p.user_id).charAt(0).toUpperCase()}
                                                            </div>
                                                        </Tooltip>
                                                    ))
                                                ) : (
                                                    <div className="text-[13px] text-text-muted italic">Empty right now</div>
                                                )}
                                                {overflow > 0 && (
                                                    <div className="z-10 -ml-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-bg-mod-subtle bg-bg-accent text-[11px] font-bold text-text-primary">
                                                        +{overflow}
                                                    </div>
                                                )}
                                            </div>

                                            <button
                                                className="mt-auto w-full rounded-xl bg-bg-mod-strong py-2 text-sm font-bold text-text-primary transition-colors duration-150 hover:bg-accent-primary hover:text-text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary active:scale-[0.98]"
                                                onClick={() => navigate(`/app/guilds/${guild.id}/channels/${vc.id}`)}
                                            >
                                                Join Voice
                                            </button>
                                        </div>
                                    );
                                })
                            ) : (
                                <div className="col-span-full rounded-2xl border border-border-subtle border-dashed p-8 text-center text-text-muted">
                                    No voice channels available.
                                </div>
                            )}
                        </div>
                    </section>

                    {/* Recent Discussions / Pinned */}
                    <section>
                        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold leading-snug text-text-primary">
                            <MessageSquare className="text-text-primary" size={20} />
                            {pinnedChannelIds.length > 0 ? "Featured Channels" : "Recent Discussions"}
                        </h2>
                        <div className="rounded-[16px] border border-border-subtle bg-bg-mod-subtle">
                            {displayThreads.length > 0 ? (
                                displayThreads.map((tc, idx: number) => (
                                    <button
                                        type="button"
                                        key={tc.id}
                                        onClick={() => navigate(`/app/guilds/${guild.id}/channels/${tc.id}`)}
                                        className={cn(
                                            "flex w-full items-start gap-4 p-4 text-left transition-colors duration-150 hover:bg-bg-mod-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary",
                                            idx !== displayThreads.length - 1 && "border-b border-border-subtle"
                                        )}
                                    >
                                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong text-text-muted">
                                            <Hash size={20} />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <div className="flex items-baseline gap-2">
                                                <span className="font-bold text-text-primary">#{tc.name}</span>
                                                {tc.topic && <span className="text-[13px] text-text-muted line-clamp-1">{tc.topic}</span>}
                                            </div>
                                            <p className="text-sm text-text-secondary line-clamp-2">
                                                Click to view the latest messages in this channel and join the conversation.
                                            </p>
                                        </div>
                                    </button>
                                ))
                            ) : (
                                <div className="p-8 text-center text-text-muted">
                                    No text channels available.
                                </div>
                            )}
                        </div>
                    </section>
                </div>

                {/* Right Sidebar */}
                <div className="flex flex-col gap-6">
                    <section>
                        <div className="rounded-[16px] border border-border-subtle bg-bg-mod-subtle p-5">
                            <h3 className="mb-2 text-base font-bold text-text-primary">About this Server</h3>
                            <p className="mb-4 text-sm leading-relaxed text-text-secondary">
                                A federated community powered by Paracord. This hub provides a quick overview of what's happening right now.
                            </p>
                            <div className="flex flex-col gap-3 text-[14px]">
                                <div className="flex items-center justify-between gap-3">
                                    <span className="shrink-0 text-text-muted">Server ID</span>
                                    <span className="truncate font-mono text-[12px] text-text-primary">{guild.id.split('-')[0]}</span>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section>
                        <div className="flex flex-col items-center gap-3 rounded-[16px] border border-accent-primary/30 bg-accent-primary/10 p-5 text-center">
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-primary text-text-on-accent">
                                <Plus size={24} />
                            </div>
                            <div>
                                <h3 className="mb-1 text-base font-bold text-text-primary">Invite Friends</h3>
                                <p className="text-[13px] text-text-secondary">Grow the community by inviting others to join.</p>
                            </div>
                            <button
                                className="mt-2 w-full rounded-xl bg-accent-primary py-2.5 text-sm font-bold text-text-on-accent transition-colors duration-150 hover:bg-accent-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary active:scale-[0.98]"
                                onClick={() => {
                                    const firstVoice = voiceChannels[0]?.id;
                                    const firstText = textChannels[0]?.id;
                                    const target = firstText || firstVoice;
                                    if (target) {
                                        navigate(`/app/guilds/${guild.id}/channels/${target}`);
                                    }
                                }}
                            >
                                Go to Channels
                            </button>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
