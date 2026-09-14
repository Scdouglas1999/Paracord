import { useState, ChangeEvent } from 'react';
import { Upload, X, Hash } from 'lucide-react';
import { Guild, Channel, HubSettings, Role } from '../../types';
import { isAllowedImageMimeType, isSafeImageDataUrl, safeStoredImageDataUrl } from '../../lib/security';
import { cn } from '../../lib/utils';
import { guildApi } from '../../api/guilds';
import { extractApiError } from '../../api/client';
import { Button, Divider, Input, Textarea } from '../ui';
import { SectionHeader, FieldLabel, GroupLabel, ToggleRow } from './SettingsPrimitives';

type VisibilityMode = 'private' | 'public' | 'roles';

interface ServerHubSettingsProps {
    guild: Guild;
    channels: Channel[];
    roles?: Role[];
    onUpdate: () => void;
    setError: (msg: string | null) => void;
}

// A picked option is a raised row inside the settings plate (§4); an unpicked
// one is bare ground with a hover wash. Never a bordered tint box.
const optionRow = (selected: boolean) =>
    cn(
        'flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5 text-label',
        'transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        selected
            ? 'bg-bg-raised text-text-primary shadow-[var(--shadow-raised)]'
            : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
    );

export function ServerHubSettings({ guild, channels, roles = [], onUpdate, setError }: ServerHubSettingsProps) {
    const [loading, setLoading] = useState(false);
    const [hubSettings, setHubSettings] = useState<HubSettings>(
        guild.hub_settings || {}
    );
    const [visibility, setVisibility] = useState<VisibilityMode>(
        guild.visibility === 'public' || guild.visibility === 'roles' ? guild.visibility : 'private'
    );
    const [discoveryTags, setDiscoveryTags] = useState((guild.discovery_tags || []).join(', '));
    const [allowedRoleIds, setAllowedRoleIds] = useState<string[]>(guild.allowed_roles || []);

    const textChannels = channels.filter(c => c.type === 0 || c.channel_type === 0);
    const assignableRoles = roles.filter((role) => role.id !== guild.id);

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

    const toggleAllowedRole = (roleId: string) => {
        setAllowedRoleIds((prev) =>
            prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
        );
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
        if (visibility === 'roles' && allowedRoleIds.length === 0) {
            setError('Pick at least one role when visibility is role-gated.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await guildApi.update(guild.id, {
                hub_settings: hubSettings,
                visibility,
                discovery_tags: discoveryTags
                    .split(',')
                    .map(tag => tag.trim())
                    .filter(Boolean),
                allowed_roles: visibility === 'roles' ? allowedRoleIds : [],
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
        <div className="flex flex-col gap-8">
            <SectionHeader
                title="Server hub"
                description="Design the landing page members see before they join — a banner, a welcome, and the channels you want front and center."
                action={
                    <Button variant="primary" onClick={handleSave} loading={loading} disabled={loading}>
                        Save changes
                    </Button>
                }
            />

            <Divider />

            {/* Banner */}
            <section>
                <GroupLabel>Hub banner</GroupLabel>
                <p className="mt-2 text-body leading-relaxed text-text-secondary">
                    A wide image sets the tone. Aim for 1200×480 — PNG, JPG, or WEBP up to 2 MB.
                </p>
                <div className="mt-4">
                    {bannerSrc ? (
                        <div className="flex flex-col items-start gap-3">
                            <div className="pc-well h-44 w-full overflow-hidden p-0">
                                <img
                                    src={bannerSrc}
                                    alt="Hub banner preview"
                                    className="h-full w-full object-cover"
                                />
                            </div>
                            <Button variant="danger" onClick={removeBanner}>
                                <X size={16} /> Remove banner
                            </Button>
                        </div>
                    ) : (
                        <label
                            className={cn(
                                'pc-well flex h-36 w-full cursor-pointer flex-col items-center justify-center gap-1.5',
                                'text-text-muted transition-[box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                                'focus-within:shadow-[var(--shadow-well),var(--focus-ring)]',
                            )}
                        >
                            <Upload size={22} aria-hidden />
                            <span className="text-label text-text-secondary">Upload a banner image</span>
                            <span className="pc-mono text-meta">PNG, JPG, or WEBP · 2 MB max</span>
                            <input type="file" className="sr-only" accept="image/*" onChange={handleBannerUpload} />
                        </label>
                    )}
                </div>
            </section>

            <Divider />

            {/* Welcome copy */}
            <section>
                <GroupLabel>Welcome copy</GroupLabel>
                <div className="mt-4 flex flex-col gap-5">
                    <label className="block">
                        <FieldLabel>Headline</FieldLabel>
                        <Input
                            value={hubSettings.welcome_text || ''}
                            onChange={e => handleTextChange('welcome_text', e.target.value)}
                            placeholder="A short, warm one-liner"
                            maxLength={100}
                        />
                    </label>
                    <label className="block">
                        <FieldLabel>About this server</FieldLabel>
                        <Textarea
                            value={hubSettings.description || ''}
                            onChange={e => handleTextChange('description', e.target.value)}
                            className="min-h-[100px] resize-y"
                            placeholder="What is this community for? Who is it for?"
                            maxLength={2000}
                        />
                    </label>
                </div>
            </section>

            <Divider />

            {/* Discovery / visibility */}
            <section>
                <GroupLabel>Visibility</GroupLabel>
                <div className="mt-2">
                    <ToggleRow
                        label="List this server publicly"
                        description="Public servers can surface in discovery. Leave off for invite-only communities."
                        checked={visibility === 'public'}
                        onChange={(checked) => setVisibility(checked ? 'public' : 'private')}
                    />
                    <Divider />
                    <ToggleRow
                        label="Role-gated sidebar"
                        description="Only members with one of the selected roles see this server in their list. Not listed in discovery."
                        checked={visibility === 'roles'}
                        onChange={(checked) =>
                            setVisibility(checked ? 'roles' : visibility === 'public' ? 'public' : 'private')
                        }
                    />
                </div>
                {visibility === 'roles' && (
                    <div className="mt-5">
                        <FieldLabel>Allowed roles</FieldLabel>
                        <p className="mt-2 text-meta leading-relaxed text-text-muted">
                            Members need at least one of these roles to see the server.
                        </p>
                        {assignableRoles.length === 0 ? (
                            <p className="mt-3 text-body leading-relaxed text-text-secondary">
                                Create a role first, then pick it here.
                            </p>
                        ) : (
                            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {assignableRoles.map((role) => {
                                    const selected = allowedRoleIds.includes(role.id);
                                    return (
                                        <label key={role.id} className={optionRow(selected)}>
                                            <input
                                                type="checkbox"
                                                checked={selected}
                                                onChange={() => toggleAllowedRole(role.id)}
                                                className="pc-checkbox"
                                            />
                                            <span
                                                className="h-3 w-3 shrink-0 rounded-[var(--radius-full)]"
                                                aria-hidden
                                                style={{
                                                    // A role's colour is the member's own choice — data.
                                                    backgroundColor: role.color
                                                        ? `#${role.color.toString(16).padStart(6, '0')}`
                                                        : 'var(--text-muted)',
                                                }}
                                            />
                                            <span className="truncate">{role.name}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
                <div className="mt-5">
                    <label className="block">
                        <FieldLabel>Discovery tags</FieldLabel>
                        <Input
                            value={discoveryTags}
                            onChange={e => setDiscoveryTags(e.target.value)}
                            placeholder="gaming, open-source, friends"
                            maxLength={240}
                            disabled={visibility !== 'public'}
                        />
                    </label>
                    <p className="mt-2 text-meta leading-relaxed text-text-muted">
                        Comma-separated — helps the right people find you.
                    </p>
                </div>
            </section>

            <Divider />

            {/* Pinned channels */}
            <section>
                <GroupLabel>Pinned channels</GroupLabel>
                <p className="mt-2 text-body leading-relaxed text-text-secondary">
                    Feature a few channels on the hub — rules, announcements, or wherever newcomers should land first.
                </p>
                {textChannels.length === 0 ? (
                    <p className="mt-4 text-body leading-relaxed text-text-secondary">
                        No text channels yet. Create one and it'll be pinnable here.
                    </p>
                ) : (
                    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {textChannels.map(channel => {
                            const isPinned = (hubSettings.pinned_channels || []).includes(channel.id);
                            return (
                                <label key={channel.id} className={optionRow(isPinned)}>
                                    <input
                                        type="checkbox"
                                        checked={isPinned}
                                        onChange={() => togglePinnedChannel(channel.id)}
                                        className="pc-checkbox"
                                    />
                                    <Hash size={15} className="shrink-0 text-channel-icon" aria-hidden />
                                    <span className="truncate">{channel.name}</span>
                                </label>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );
}
