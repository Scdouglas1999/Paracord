import { useEffect, useState } from 'react';
import { Upload, FileText, Hash, Volume2, Folder } from 'lucide-react';
import { Modal, ModalTitle } from '../ui/Modal';
import { useAuthStore } from '../../stores/authStore';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { inviteApi } from '../../api/invites';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { useNavigate } from 'react-router-dom';
import { isAllowedImageMimeType } from '../../lib/security';

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

export function CreateGuildModal({ onClose }: CreateGuildModalProps) {
  const user = useAuthStore(s => s.user);
  const navigate = useNavigate();
  const [tab, setTab] = useState<'create' | 'join' | 'template'>('create');
  const [serverName, setServerName] = useState(`${user?.username || 'My'}'s server`);
  const [inviteCode, setInviteCode] = useState('');
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
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

  const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
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
    }
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
      setError(extractApiError(err) || 'Failed to create server');
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
      setError(extractApiError(err) || 'Failed to join server');
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
      setError(extractApiError(err) || 'Failed to create server from template');
    } finally {
      setLoading(false);
    }
  };

  const channelIcon = (type: number) => {
    switch (type) {
      case 2: return <Volume2 size={14} style={{ color: 'var(--text-muted)' }} />;
      case 4: return <Folder size={14} style={{ color: 'var(--text-muted)' }} />;
      default: return <Hash size={14} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  const tabTitle = tab === 'create' ? 'Create a Server' : tab === 'join' ? 'Join a Server' : 'From Template';
  const tabSubtitle =
    tab === 'create'
      ? 'Your server is where you and your friends hang out.'
      : tab === 'join'
        ? 'Enter an invite below to join an existing server.'
        : 'Start with a pre-made server structure.';

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
        <div className="px-8 pb-5 pt-8 text-center">
          <ModalTitle id="create-guild-modal-title" className="text-xl">
            {tabTitle}
          </ModalTitle>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {tabSubtitle}
          </p>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-3 py-2 text-sm font-medium"
              style={{ color: 'var(--accent-danger)' }}
            >
              {error}
            </p>
          )}

          {/* Tab switcher */}
          <div className="mt-5 flex gap-2 rounded-xl p-1" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <button
              className={`tab-btn flex-1 py-2 ${tab === 'create' ? 'active' : ''}`}
              style={tab === 'create' ? { backgroundColor: 'var(--bg-primary)' } : {}}
              onClick={() => { setTab('create'); setError(''); }}
            >
              Create
            </button>
            <button
              className={`tab-btn flex-1 py-2 ${tab === 'join' ? 'active' : ''}`}
              style={tab === 'join' ? { backgroundColor: 'var(--bg-primary)' } : {}}
              onClick={() => { setTab('join'); setError(''); }}
            >
              Join
            </button>
            <button
              className={`tab-btn flex-1 py-2 ${tab === 'template' ? 'active' : ''}`}
              style={tab === 'template' ? { backgroundColor: 'var(--bg-primary)' } : {}}
              onClick={() => { setTab('template'); setError(''); }}
            >
              Template
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-8 pb-8 sm:px-8 sm:pb-8">
          {tab === 'create' ? (
            <div className="space-y-6">
              <div className="flex justify-center">
                <label className="cursor-pointer">
                  <input type="file" accept="image/*" className="hidden" onChange={handleIconChange} />
                  <div
                    className="flex h-24 w-24 flex-col items-center justify-center rounded-full border-2 border-dashed transition-colors"
                    style={{
                      borderColor: 'var(--interactive-muted)',
                      backgroundColor: iconPreview ? 'transparent' : 'var(--bg-secondary)',
                    }}
                  >
                    {iconPreview ? (
                      <img src={iconPreview} alt="Icon" className="w-full h-full rounded-full object-cover" />
                    ) : (
                      <>
                        <Upload size={22} style={{ color: 'var(--text-muted)' }} />
                        <span className="text-[10px] mt-0.5 font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>
                          Upload
                        </span>
                      </>
                    )}
                  </div>
                </label>
              </div>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                  Server Name
                </span>
                <input
                  type="text"
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  className="input-field mt-3"
                />
              </label>
            </div>
          ) : tab === 'join' ? (
            <div className="space-y-6">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                  Invite Link
                </span>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="https://paracord.gg/hTKzmak"
                  className="input-field mt-3"
                />
              </label>
              <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-3.5 py-3">
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                  Invites should look like
                </span>
                <div className="mt-1.5 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
                  hTKzmak<br />
                  https://paracord.gg/hTKzmak
                </div>
              </div>
            </div>
          ) : (
            /* Template tab */
            <div className="space-y-4">
              {templatesLoading ? (
                <p className="text-center text-sm py-4" style={{ color: 'var(--text-muted)' }}>Loading templates...</p>
              ) : templates.length === 0 ? (
                <div className="text-center py-6">
                  <FileText size={32} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No templates available yet.</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Create one from an existing server's settings.
                  </p>
                </div>
              ) : !selectedTemplate ? (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {templates.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      className="w-full text-left rounded-xl border border-border-subtle p-3 transition-colors hover:border-accent-primary/50"
                      style={{ backgroundColor: 'var(--bg-secondary)' }}
                      aria-label={`Use template ${t.name}`}
                      onClick={() => {
                        setSelectedTemplate(t);
                        setTemplateGuildName(`${user?.username || 'My'}'s server`);
                        setError('');
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{t.name}</span>
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {t.template_data.channels.length} channels
                        </span>
                      </div>
                      {t.description && (
                        <p className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{t.description}</p>
                      )}
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        Used {t.usage_count} {t.usage_count === 1 ? 'time' : 'times'}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  <button
                    type="button"
                    className="text-xs font-medium"
                    style={{ color: 'var(--accent-primary)' }}
                    onClick={() => { setSelectedTemplate(null); setError(''); }}
                  >
                    &larr; Back to templates
                  </button>

                  <div className="rounded-xl border border-border-subtle p-3" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                    <p className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{selectedTemplate.name}</p>
                    {selectedTemplate.description && (
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{selectedTemplate.description}</p>
                    )}

                    {/* Channel preview */}
                    <div className="mt-3 space-y-1 max-h-32 overflow-y-auto">
                      {selectedTemplate.template_data.channels
                        .sort((a, b) => a.position - b.position)
                        .map((ch, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 text-xs"
                            style={{
                              color: 'var(--text-muted)',
                              paddingLeft: ch.parent_name ? '1rem' : '0',
                            }}
                          >
                            {channelIcon(ch.type)}
                            <span>{ch.name}</span>
                          </div>
                        ))}
                    </div>

                    {selectedTemplate.template_data.roles.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {selectedTemplate.template_data.roles.map((r, i) => (
                          <span
                            key={i}
                            className="inline-block rounded-full px-2 py-0.5 text-xs"
                            style={{
                              backgroundColor: 'var(--bg-tertiary)',
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
                    <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                      Server Name
                    </span>
                    <input
                      type="text"
                      aria-label="Template server name"
                      value={templateGuildName}
                      onChange={(e) => setTemplateGuildName(e.target.value)}
                      className="input-field mt-3"
                    />
                  </label>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex flex-col-reverse items-stretch gap-5 border-t border-border-subtle/70 px-8 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:py-6"
          style={{ backgroundColor: 'var(--bg-secondary)' }}
        >
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button
            onClick={
              tab === 'create'
                ? handleCreate
                : tab === 'join'
                  ? handleJoin
                  : handleApplyTemplate
            }
            disabled={loading || (tab === 'template' && !selectedTemplate)}
            className="btn-primary min-w-[9rem]"
          >
            {loading
              ? 'Working...'
              : tab === 'create'
                ? 'Create'
                : tab === 'join'
                  ? 'Join Server'
                  : 'Create from Template'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
