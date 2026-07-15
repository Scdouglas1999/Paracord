import { useEffect, useState } from 'react';
import { Upload, LayoutTemplate, Hash, Volume2, Folder, ChevronLeft, ArrowRight } from 'lucide-react';
import { Modal, ModalTitle } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ErrorBanner, EmptyState } from '../ui/Feedback';
import { FieldLabel } from './SettingsPrimitives';
import { useAuthStore } from '../../stores/authStore';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { inviteApi } from '../../api/invites';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { useNavigate } from 'react-router-dom';
import { isAllowedImageMimeType } from '../../lib/security';
import { cn } from '../../lib/utils';

interface GuildTemplate {
  id: string;
  name: string;
  description: string;
  creator_id: string;
  source_guild_id: string | null;
  template_data: {
    channels: { name: string; type: number; position: number; parent_name: string | null }[];
    roles: { name: string; permissions: string; color: number; position: number }[];
  };
  usage_count: number;
  created_at: string;
}

interface CreateGuildModalProps {
  onClose: () => void;
}

type Tab = 'create' | 'join' | 'template';

const TABS: { id: Tab; label: string }[] = [
  { id: 'create', label: 'Create' },
  { id: 'join', label: 'Join' },
  { id: 'template', label: 'Template' },
];

export function CreateGuildModal({ onClose }: CreateGuildModalProps) {
  const user = useAuthStore(s => s.user);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('create');
  const [serverName, setServerName] = useState(`${user?.username || 'My'}'s space`);
  const [inviteCode, setInviteCode] = useState('');
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
  const [iconDragActive, setIconDragActive] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Template state
  const [templates, setTemplates] = useState<GuildTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<GuildTemplate | null>(null);
  const [templateGuildName, setTemplateGuildName] = useState('');

  useEffect(() => {
    return () => {
      if (iconPreview?.startsWith('blob:')) {
        URL.revokeObjectURL(iconPreview);
      }
    };
  }, [iconPreview]);

  useEffect(() => {
    if (tab === 'template' && templates.length === 0 && !templatesLoading) {
      setTemplatesLoading(true);
      getApi()
        .get<GuildTemplate[]>('/templates')
        .then(res => setTemplates(res.data))
        .catch((err: unknown) => setError(`Failed to load templates: ${extractApiError(err)}`))
        .finally(() => setTemplatesLoading(false));
    }
  }, [tab]);

  const processIconFile = (file: File | undefined) => {
    if (!file) return;
    if (!isAllowedImageMimeType(file.type)) {
      setError('Please upload PNG, JPG, GIF, or WEBP.');
      return;
    }
    setError('');
    const objectUrl = URL.createObjectURL(file);
    setIconPreview(objectUrl);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setIconDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processIconFile(e.target.files?.[0]);
  };

  const navigateToGuild = async (guild: { id: string }) => {
    await useChannelStore.getState().fetchChannels(guild.id);
    const channels = useChannelStore.getState().channelsByGuild[guild.id] || [];
    const firstChannel = channels.find(c => c.type === 0) || channels.find(c => c.type !== 4) || channels[0];
    onClose();
    if (firstChannel) {
      useChannelStore.getState().selectGuild(guild.id);
      useChannelStore.getState().selectChannel(firstChannel.id);
      navigate(`/app/guilds/${guild.id}/channels/${firstChannel.id}`);
    } else {
      useUIStore.getState().setGuildSettingsId(guild.id);
      navigate(`/app`);
    }
  };

  const handleCreate = async () => {
    if (!serverName.trim()) return;
    setError('');
    setLoading(true);
    try {
      const guild = await useGuildStore.getState().createGuild(serverName.trim(), iconDataUrl || undefined);
      await navigateToGuild(guild);
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Failed to create space');
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!inviteCode.trim()) return;
    setError('');
    setLoading(true);
    try {
      const code = inviteCode.trim().split('/').pop() || inviteCode.trim();
      const { data } = await inviteApi.accept(code);
      const guild = 'guild' in data ? data.guild : data;
      useGuildStore.getState().addGuild(guild);
      await useChannelStore.getState().fetchChannels(guild.id);
      const channels = useChannelStore.getState().channelsByGuild[guild.id] || [];
      const firstChannelId =
        guild.default_channel_id ||
        channels.find((c) => c.type === 0)?.id ||
        channels.find((c) => c.type !== 4)?.id ||
        channels[0]?.id;
      onClose();
      if (firstChannelId) {
        useChannelStore.getState().selectGuild(guild.id);
        useChannelStore.getState().selectChannel(firstChannelId);
        navigate(`/app/guilds/${guild.id}/channels/${firstChannelId}`);
      } else {
        useUIStore.getState().setGuildSettingsId(guild.id);
        navigate(`/app`);
      }
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Failed to join space');
    } finally {
      setLoading(false);
    }
  };

  const handleApplyTemplate = async () => {
    if (!selectedTemplate || !templateGuildName.trim()) return;
    setError('');
    setLoading(true);
    try {
      const { data: guild } = await getApi().post(`/templates/${selectedTemplate.id}/apply`, {
        name: templateGuildName.trim(),
      });
      useGuildStore.getState().addGuild(guild);
      await navigateToGuild(guild);
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Failed to create space from template');
    } finally {
      setLoading(false);
    }
  };

  const channelIcon = (type: number) => {
    switch (type) {
      case 2: return <Volume2 size={14} className="shrink-0 text-channel-icon" />;
      case 4: return <Folder size={14} className="shrink-0 text-channel-icon" />;
      default: return <Hash size={14} className="shrink-0 text-channel-icon" />;
    }
  };

  const tabTitle = tab === 'create' ? 'Create a space' : tab === 'join' ? 'Join a space' : 'Start from a template';
  const tabSubtitle =
    tab === 'create'
      ? 'Your space is where you and your people hang out — give it a name and make it yours.'
      : tab === 'join'
        ? 'Have an invite? Drop it in below to land in an existing community.'
        : 'Skip the setup — pick a ready-made structure and rename it in one step.';

  const footerAction =
    tab === 'create' ? handleCreate : tab === 'join' ? handleJoin : handleApplyTemplate;
  const footerLabel = tab === 'create' ? 'Create' : tab === 'join' ? 'Join space' : 'Create from Template';

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="create-guild-modal-title"
      showCloseButton
      panelClassName="w-[min(92vw,32rem)]"
    >
      <div className="max-h-[min(86dvh,42rem)] overflow-auto">
        {/* Header */}
        <div className="border-b border-border-subtle px-6 pb-5 pt-6 pr-14">
          <ModalTitle id="create-guild-modal-title">{tabTitle}</ModalTitle>
          <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{tabSubtitle}</p>

          {/* Mode selector — a segmented control, the active step in emerald */}
          <div className="mt-4 flex gap-1 rounded-sm bg-bg-tertiary p-1">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => { setTab(id); setError(''); }}
                className={cn(
                  'flex-1 rounded-sm px-3 py-1.5 text-label font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                  tab === id
                    ? 'bg-accent-primary text-text-on-accent shadow-sm'
                    : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {error && <ErrorBanner message={error} className="mb-5" />}

          {tab === 'create' ? (
            <div className="space-y-5">
              <div className="flex justify-center">
                <label
                  onDragOver={(e) => { e.preventDefault(); setIconDragActive(true); }}
                  onDragLeave={() => setIconDragActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIconDragActive(false);
                    processIconFile(e.dataTransfer.files?.[0]);
                  }}
                  className={cn(
                    'group flex h-24 w-24 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-md border-2 border-dashed text-center transition-colors duration-[140ms] ease-[var(--ease-out)]',
                    iconDragActive
                      ? 'border-accent-primary bg-accent-tint'
                      : 'border-border-strong hover:border-accent-primary hover:bg-accent-tint',
                  )}
                >
                  <input type="file" accept="image/*" className="hidden" onChange={handleIconChange} />
                  {iconPreview ? (
                    <img src={iconPreview} alt="Space icon preview" className="h-full w-full object-cover" />
                  ) : (
                    <>
                      <Upload size={20} className="text-text-muted transition-colors group-hover:text-accent-primary" />
                      <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                        Upload
                      </span>
                    </>
                  )}
                </label>
              </div>

              <label className="block">
                <FieldLabel>Space name</FieldLabel>
                <input
                  type="text"
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  className="input-field"
                  aria-label="Space name"
                />
              </label>
            </div>
          ) : tab === 'join' ? (
            <div className="space-y-5">
              <label className="block">
                <FieldLabel>Invite Link</FieldLabel>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="https://paracord.gg/hTKzmak"
                  className="input-field"
                />
              </label>
              <div className="rounded-md border border-border-subtle bg-bg-tertiary px-4 py-3">
                <div className="text-section uppercase text-text-secondary">Invites look like</div>
                <div className="mt-1.5 space-y-0.5 font-code text-sm text-text-muted">
                  <div>hTKzmak</div>
                  <div>https://paracord.gg/hTKzmak</div>
                </div>
              </div>
            </div>
          ) : (
            /* Template tab */
            <div className="space-y-4">
              {templatesLoading ? (
                <p className="py-6 text-center text-sm text-text-muted">Loading templates…</p>
              ) : templates.length === 0 ? (
                <EmptyState
                  icon={<LayoutTemplate size={20} />}
                  title="No templates yet"
                  description="Templates come from existing spaces — open a space's settings and save its structure to reuse it here."
                />
              ) : !selectedTemplate ? (
                <div className="max-h-60 space-y-2 overflow-y-auto">
                  {templates.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      className="w-full rounded-sm border border-border-subtle bg-bg-tertiary p-3 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-accent-primary hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)]"
                      aria-label={`Use template ${t.name}`}
                      onClick={() => {
                        setSelectedTemplate(t);
                        setTemplateGuildName(`${user?.username || 'My'}'s space`);
                        setError('');
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-label font-semibold text-text-primary">{t.name}</span>
                        <span className="shrink-0 text-meta tabular-nums text-text-muted">
                          {t.template_data.channels.length} channels
                        </span>
                      </div>
                      {t.description && (
                        <p className="mt-1 line-clamp-2 text-meta text-text-secondary">{t.description}</p>
                      )}
                      <p className="mt-1 text-meta text-text-muted">
                        Used {t.usage_count} {t.usage_count === 1 ? 'time' : 'times'}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-sm text-meta font-semibold text-accent-primary outline-none transition-colors hover:text-accent-primary-hover focus-visible:shadow-[var(--focus-ring)]"
                    onClick={() => { setSelectedTemplate(null); setError(''); }}
                  >
                    <ChevronLeft size={14} />
                    Back to templates
                  </button>

                  <div className="rounded-md border border-border-subtle bg-bg-tertiary p-3">
                    <p className="text-label font-semibold text-text-primary">{selectedTemplate.name}</p>
                    {selectedTemplate.description && (
                      <p className="mt-1 text-meta text-text-secondary">{selectedTemplate.description}</p>
                    )}

                    {/* Channel preview */}
                    <div className="mt-3 max-h-32 space-y-1 overflow-y-auto">
                      {selectedTemplate.template_data.channels
                        .sort((a, b) => a.position - b.position)
                        .map((ch, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 text-meta text-text-muted"
                            style={{ paddingLeft: ch.parent_name ? '1rem' : '0' }}
                          >
                            {channelIcon(ch.type)}
                            <span className="truncate">{ch.name}</span>
                          </div>
                        ))}
                    </div>

                    {selectedTemplate.template_data.roles.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {selectedTemplate.template_data.roles.map((r, i) => (
                          <span
                            key={i}
                            className="inline-block rounded-xs bg-bg-mod-strong px-2 py-0.5 text-meta font-medium"
                            style={{
                              color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : 'var(--text-secondary)',
                            }}
                          >
                            {r.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <label className="block">
                    <FieldLabel>Space name</FieldLabel>
                    <input
                      type="text"
                      aria-label="Template space name"
                      value={templateGuildName}
                      onChange={(e) => setTemplateGuildName(e.target.value)}
                      className="input-field"
                    />
                  </label>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-border-subtle bg-bg-secondary px-6 py-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={footerAction}
            disabled={loading || (tab === 'template' && !selectedTemplate)}
            loading={loading}
            className="min-w-[9rem] gap-1.5"
          >
            {footerLabel}
            {!loading && <ArrowRight size={16} />}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
