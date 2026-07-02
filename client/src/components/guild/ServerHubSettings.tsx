import { useState, ChangeEvent } from 'react';
import { Upload, X, Save, LayoutTemplate, MessageSquare, Globe2 } from 'lucide-react';
import { Guild, Channel, HubSettings } from '../../types';
import { isAllowedImageMimeType, isSafeImageDataUrl, safeStoredImageDataUrl } from '../../lib/security';
import { cn } from '../../lib/utils';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';

interface ServerHubSettingsProps {
    guild: Guild;
    channels: Channel[];
    onUpdate: () => void;
    setError: (msg: string | null) => void;
}

export function ServerHubSettings({ guild, channels, onUpdate, setError }: ServerHubSettingsProps) {
    const [loading, setLoading] = useState(false);
    const [hubSettings, setHubSettings] = useState<HubSettings>(
        guild.hub_settings || {}
    );
    const [isDiscoverable, setIsDiscoverable] = useState(guild.visibility === 'public');
    const [discoveryTags, setDiscoveryTags] = useState((guild.discovery_tags || []).join(', '));

    const textChannels = channels.filter(c => c.type === 0 || c.channel_type === 0);

    const handleTextChange = (field: keyof HubSettings, value: string) => {
        setHubSettings(prev => ({ ...prev, [field]: value }));
    };

    const togglePinnedChannel = (channelId: string) => {
        setHubSettings(prev => {
            const current = prev.pinned_channels || [];
            if (current.includes(channelId)) {
                return { ...prev, pinned_channels: current.filter(id => id !== channelId) };
            }
            return { ...prev, pinned_channels: [...current, channelId] };
        });
    };

    const handleBannerUpload = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!isAllowedImageMimeType(file.type)) {
            setError('Please upload PNG, JPG, GIF, or WEBP.');
            return;
        }
        setError(null);
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                if (!isSafeImageDataUrl(reader.result)) {
                    setError('Please upload PNG, JPG, GIF, or WEBP.');
                    return;
                }
                setHubSettings(prev => ({ ...prev, banner_hash: reader.result as string }));
            }
        };
        reader.readAsDataURL(file);
    };

    const removeBanner = () => {
        setHubSettings(prev => {
            const { banner_hash, ...rest } = prev;
            return rest;
        });
    };

    const handleSave = async () => {
        setLoading(true);
        setError(null);
        try {
            await guildApi.update(guild.id, {
                hub_settings: hubSettings,
                visibility: isDiscoverable ? 'public' : 'private',
                discovery_tags: discoveryTags
                    .split(',')
                    .map(tag => tag.trim())
                    .filter(Boolean),
            });
            onUpdate();
        } catch (err: unknown) {
            setError(extractApiError(err) || 'Failed to update Hub Settings');
        } finally {
            setLoading(false);
        }
    };

    const bannerSrc = safeStoredImageDataUrl(hubSettings.banner_hash);

    return (
        <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack-relaxed">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="settings-section-title !mb-1 flex items-center gap-2">
                        <LayoutTemplate size={20} className="text-accent-primary" />
                        Server Hub Customization
                    </h2>
                    <p className="text-sm text-text-muted">
                        Design your server's landing page. Add a banner, welcome text, and pin important channels.
                    </p>
                </div>
                <button
                    onClick={handleSave}
                    disabled={loading}
                    aria-label={loading ? 'Saving server hub settings' : 'Save server hub settings'}
                    className="btn-primary flex items-center gap-2"
                >
                    <Save size={16} />
                    {loading ? 'Saving...' : 'Save Changes'}
                </button>
            </div>

            <div className="space-y-8">
                {/* Banner Section */}
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-5">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-3">
                        Hub Banner Image
                    </label>
                    <div className="flex flex-col gap-4">
                        {bannerSrc ? (
                            <div className="relative w-full h-40 rounded-lg overflow-hidden border border-border-subtle group">
                                <img
                                    src={bannerSrc}
                                    alt="Hub Banner"
                                    className="w-full h-full object-cover"
                                />
                                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                    <button onClick={removeBanner} className="btn-danger flex items-center gap-2">
                                        <X size={16} /> Remove Banner
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-border-strong rounded-lg cursor-pointer hover:border-interactive-normal hover:bg-bg-mod-subtle transition-colors">
                                <div className="flex flex-col items-center justify-center pt-5 pb-6 text-text-muted">
                                    <Upload size={24} className="mb-2" />
                                    <p className="text-sm font-medium">Click to upload banner</p>
                                    <p className="text-xs mt-1">PNG, JPG, or WEBP (Max 2MB)</p>
                                </div>
                                <input type="file" className="hidden" accept="image/*" onChange={handleBannerUpload} />
                            </label>
                        )}
                    </div>
                </div>

                {/* Text Customization */}
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-5 space-y-5">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2 flex items-center gap-2">
                        <MessageSquare size={14} />
                        Welcome Text / Description
                    </label>

                    <div>
                        <span className="text-xs text-text-muted mb-1 block">Headline (Optional)</span>
                        <input
                            type="text"
                            value={hubSettings.welcome_text || ''}
                            onChange={e => handleTextChange('welcome_text', e.target.value)}
                            className="input-field w-full"
                            placeholder="e.g. Welcome to our awesome community!"
                            maxLength={100}
                        />
                    </div>

                    <div>
                        <span className="text-xs text-text-muted mb-1 block">About this Server</span>
                        <textarea
                            value={hubSettings.description || ''}
                            onChange={e => handleTextChange('description', e.target.value)}
                            className="input-field w-full min-h-[100px] resize-y"
                            placeholder="Write a detailed description about what this server is for..."
                            maxLength={2000}
                        />
                    </div>
                </div>

                {/* Discovery */}
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-5 space-y-5">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2 flex items-center gap-2">
                        <Globe2 size={14} />
                        Server Discovery
                    </label>
                    <label className="flex items-start gap-3 rounded-lg border border-border-subtle p-3">
                        <input
                            type="checkbox"
                            checked={isDiscoverable}
                            onChange={e => setIsDiscoverable(e.target.checked)}
                            className="mt-1 rounded border-border-strong text-accent-primary focus:ring-accent-primary bg-bg-primary"
                        />
                        <span>
                            <span className="block text-sm font-medium text-text-primary">List this server publicly</span>
                            <span className="block text-xs text-text-muted">
                                Public servers can appear in discovery results. Leave this off for invite-only communities.
                            </span>
                        </span>
                    </label>
                    <div>
                        <span className="text-xs text-text-muted mb-1 block">Discovery Tags</span>
                        <input
                            type="text"
                            value={discoveryTags}
                            onChange={e => setDiscoveryTags(e.target.value)}
                            className="input-field w-full"
                            placeholder="gaming, open-source, friends"
                            maxLength={240}
                        />
                    </div>
                </div>

                {/* Pinned Channels */}
                <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/50 p-5">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-3">
                        Pinned Channels
                    </label>
                    <p className="text-xs text-text-muted mb-4">
                        Select channels to feature prominently on the Hub (e.g., Rules, Announcements).
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {textChannels.map(channel => {
                            const isPinned = (hubSettings.pinned_channels || []).includes(channel.id);
                            return (
                                <label
                                    key={channel.id}
                                    className={cn(
                                        "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        isPinned ? "border-accent-primary bg-accent-primary/5" : "border-border-subtle hover:bg-bg-mod-subtle"
                                    )}
                                >
                                    <input
                                        type="checkbox"
                                        checked={isPinned}
                                        onChange={() => togglePinnedChannel(channel.id)}
                                        className="rounded border-border-strong text-accent-primary focus:ring-accent-primary bg-bg-primary"
                                    />
                                    <span className="text-sm font-medium text-text-primary">
                                        # {channel.name}
                                    </span>
                                </label>
                            );
                        })}
                        {textChannels.length === 0 && (
                            <div className="text-sm text-text-muted italic col-span-2">No text channels available.</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
