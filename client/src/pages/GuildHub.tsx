import { useParams, useNavigate } from 'react-router-dom';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { useVoiceStore } from '../stores/voiceStore';
import { Hash, Volume2, MessagesSquare, Radio, UserPlus, ArrowRight } from 'lucide-react';
import { getGuildColor } from '../lib/colors';
import { Tooltip } from '../components/ui/Tooltip';
import { Button } from '../components/ui/Button';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
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

// Uppercase eyebrow that labels each hub section (design-spec --text-section).
function SectionLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <div className="mb-3 flex items-center gap-2 text-section uppercase text-text-muted">
            <span className="text-interactive-normal">{icon}</span>
            {children}
        </div>
    );
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
                className="flex h-full flex-col overflow-hidden bg-bg-primary"
            >
                <div className="h-[168px] shrink-0 animate-pulse border-b border-border-subtle bg-bg-secondary sm:h-[188px]" />
                <div className="grid flex-1 grid-cols-1 gap-6 p-6 lg:p-8 xl:grid-cols-[2fr_1fr]">
                    <div className="flex flex-col gap-4">
                        <div className="h-3 w-32 animate-pulse rounded-xs bg-bg-mod-subtle" />
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {Array.from({ length: 2 }, (_, i) => (
                                <div key={i} className="h-40 animate-pulse rounded-md border border-border-subtle bg-bg-secondary" />
                            ))}
                        </div>
                    </div>
                    <div className="h-48 animate-pulse rounded-md border border-border-subtle bg-bg-secondary" />
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
    const guildInitial = guild.name.trim().charAt(0).toUpperCase() || '#';

    const headerTitle = guild.hub_settings?.welcome_text || `Welcome to ${guild.name}`;
    const headerDescription =
        guild.hub_settings?.description ||
        (guildServerHost
            ? `Federated server on ${guildServerHost}. Jump into an active voice room or catch up on the latest discussions.`
            : 'A community you host yourself. Jump into an active voice room or catch up on the latest discussions.');

    const jumpTarget = textChannels[0]?.id || voiceChannels[0]?.id;

    return (
        <div className="flex h-full flex-col overflow-y-auto scrollbar-thin bg-bg-primary">
            {/* Framed header — an intentional raised surface, never a diagonal gradient hero. */}
            <header className="relative shrink-0 overflow-hidden border-b border-border-subtle bg-bg-secondary shadow-sm">
                {bannerSrc && (
                    <div className="absolute inset-0">
                        <img
                            src={bannerSrc}
                            alt="Server Banner"
                            className="h-full w-full object-cover"
                        />
                        {/* Vertical legibility scrim over the photo — not a decorative wash. */}
                        <div className="absolute inset-0 bg-gradient-to-t from-bg-secondary via-bg-secondary/75 to-bg-secondary/25" />
                    </div>
                )}
                <div className="relative flex items-end gap-4 px-6 pb-6 pt-10 sm:px-8 sm:pt-14">
                    <div
                        className="hidden h-16 w-16 shrink-0 items-center justify-center rounded-md text-2xl font-bold text-text-on-accent shadow-sm sm:flex"
                        style={{ backgroundColor: guildColor }}
                        aria-hidden="true"
                    >
                        {guildInitial}
                    </div>
                    <div className="min-w-0">
                        <h1 className="truncate font-display text-title text-text-primary sm:text-display">
                            {headerTitle}
                        </h1>
                        <p className="mt-1.5 line-clamp-2 max-w-2xl text-body text-text-secondary">
                            {headerDescription}
                        </p>
                    </div>
                </div>
            </header>

            <div className="grid flex-1 grid-cols-1 gap-8 p-6 sm:p-7 lg:p-8 xl:grid-cols-[2fr_1fr] xl:items-start xl:gap-10">
                <div className="flex flex-col gap-9">
                    {/* Active Voice */}
                    <section>
                        <SectionLabel icon={<Radio size={15} />}>Happening now</SectionLabel>
                        {displayVoiceChannels.length > 0 ? (
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                {displayVoiceChannels.map((vc) => {
                                    const participants = channelParticipants.get(vc.id) || [];
                                    const displayParticipants = participants.slice(0, 4);
                                    const overflow = participants.length > 4 ? participants.length - 4 : 0;
                                    const live = participants.length > 0;

                                    return (
                                        <div
                                            key={vc.id}
                                            className="group flex flex-col gap-3 rounded-md border border-border-subtle bg-bg-secondary p-4 shadow-sm transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong"
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="flex min-w-0 items-center gap-2 text-label font-semibold text-text-primary">
                                                    <Volume2 size={16} className="shrink-0 text-channel-icon" />
                                                    <span className="truncate">{vc.name}</span>
                                                </div>
                                                {live ? (
                                                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-xs bg-success-tint px-1.5 py-0.5 text-meta font-semibold text-accent-success">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-accent-success" />
                                                        {participants.length} live
                                                    </span>
                                                ) : (
                                                    <span className="shrink-0 text-meta text-text-muted">Empty</span>
                                                )}
                                            </div>

                                            <div className="flex min-h-8 items-center">
                                                {displayParticipants.length > 0 ? (
                                                    <>
                                                        {displayParticipants.map((p, i: number) => (
                                                            <Tooltip key={p.user_id} content={p.username || p.user_id} side="top">
                                                                <div
                                                                    className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-bg-secondary bg-accent-primary text-meta font-bold text-text-on-accent"
                                                                    style={{ marginLeft: i > 0 ? '-8px' : '0' }}
                                                                >
                                                                    {(p.username || p.user_id).charAt(0).toUpperCase()}
                                                                </div>
                                                            </Tooltip>
                                                        ))}
                                                        {overflow > 0 && (
                                                            <div className="z-10 -ml-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-bg-secondary bg-bg-accent text-meta font-bold text-text-secondary">
                                                                +{overflow}
                                                            </div>
                                                        )}
                                                    </>
                                                ) : (
                                                    <span className="text-meta text-text-muted">No one here yet — start the room.</span>
                                                )}
                                            </div>

                                            <Button
                                                variant={live ? 'secondary' : 'outline'}
                                                size="sm"
                                                className="mt-auto w-full"
                                                onClick={() => navigate(`/app/guilds/${guild.id}/channels/${vc.id}`)}
                                            >
                                                <Volume2 size={15} className="mr-1.5" />
                                                {live ? 'Join the room' : 'Open voice'}
                                            </Button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
                                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
                                    <Volume2 size={18} />
                                </div>
                                <h3 className="text-subhead text-text-primary">No voice rooms yet</h3>
                                <p className="mt-1 max-w-prose text-label text-text-secondary">
                                    Add a voice channel from the sidebar and it'll show up here the moment
                                    someone hops in.
                                </p>
                            </div>
                        )}
                    </section>

                    {/* Recent Discussions / Pinned */}
                    <section>
                        <SectionLabel icon={<MessagesSquare size={15} />}>
                            {pinnedChannelIds.length > 0 ? 'Featured channels' : 'Recent discussions'}
                        </SectionLabel>
                        {displayThreads.length > 0 ? (
                            <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                                {displayThreads.map((tc, idx: number) => (
                                    <button
                                        type="button"
                                        key={tc.id}
                                        onClick={() => navigate(`/app/guilds/${guild.id}/channels/${tc.id}`)}
                                        className={`group flex w-full items-center gap-4 px-4 py-3.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[inset_var(--focus-ring)] ${idx !== displayThreads.length - 1 ? 'border-b border-border-subtle' : ''}`}
                                    >
                                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-bg-tertiary text-channel-icon">
                                            <Hash size={18} />
                                        </div>
                                        <div className="flex min-w-0 flex-col gap-0.5">
                                            <span className="truncate text-label font-semibold text-text-primary">#{tc.name}</span>
                                            <span className="truncate text-meta text-text-secondary">
                                                {tc.topic || 'Open the channel to catch up on the latest messages.'}
                                            </span>
                                        </div>
                                        <ArrowRight
                                            size={16}
                                            className="ml-auto shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                                        />
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
                                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
                                    <Hash size={18} />
                                </div>
                                <h3 className="text-subhead text-text-primary">No text channels yet</h3>
                                <p className="mt-1 max-w-prose text-label text-text-secondary">
                                    Create your first channel to give the community a place to talk.
                                </p>
                            </div>
                        )}
                    </section>
                </div>

                {/* Right rail */}
                <aside className="flex flex-col gap-6">
                    <section className="rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
                        <SectionLabel icon={<Hash size={15} />}>About this server</SectionLabel>
                        <p className="text-label leading-relaxed text-text-secondary">
                            A federated community powered by Paracord. Everything you post stays on the
                            server its owner runs.
                        </p>
                        <div className="mt-4 flex flex-col divide-y divide-border-subtle border-t border-border-subtle">
                            <div className="flex items-center justify-between gap-3 py-2.5">
                                <span className="text-meta text-text-muted">Text channels</span>
                                <span className="text-label font-semibold tabular-nums text-text-primary">{textChannels.length}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3 py-2.5">
                                <span className="text-meta text-text-muted">Voice rooms</span>
                                <span className="text-label font-semibold tabular-nums text-text-primary">{voiceChannels.length}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3 py-2.5">
                                <span className="text-meta text-text-muted">Server ID</span>
                                <span className="truncate font-code text-meta text-text-secondary">{guild.id.split('-')[0]}</span>
                            </div>
                        </div>
                        {jumpTarget && (
                            <Button
                                className="mt-5 w-full"
                                onClick={() => navigate(`/app/guilds/${guild.id}/channels/${jumpTarget}`)}
                            >
                                Jump to a channel
                                <ArrowRight size={16} className="ml-1.5" />
                            </Button>
                        )}
                    </section>

                    <section className="rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
                        <div className="flex items-start gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
                                <UserPlus size={18} />
                            </div>
                            <div className="min-w-0">
                                <h3 className="text-subhead text-text-primary">Grow the community</h3>
                                <p className="mt-1 text-label text-text-secondary">
                                    Invite the people you want here — friends, teammates, or the whole crew.
                                </p>
                            </div>
                        </div>
                        <Button
                            variant="outline"
                            className="mt-4 w-full"
                            onClick={() => {
                                if (jumpTarget) {
                                    navigate(`/app/guilds/${guild.id}/channels/${jumpTarget}`);
                                }
                            }}
                        >
                            Open a channel to invite
                        </Button>
                    </section>
                </aside>
            </div>
        </div>
    );
}
