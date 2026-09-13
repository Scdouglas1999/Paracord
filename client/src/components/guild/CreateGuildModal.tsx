import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { guildLandingPath } from '../../lib/guildNavigation';
import type { ScopedGuild } from '../../lib/guildScope';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useEffect, useState } from 'react';
import { Upload, LayoutTemplate, Hash, Volume2, Folder, ChevronLeft, ArrowRight } from 'lucide-react';
import {
  Modal,
  ModalBody,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../ui/Modal';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Divider } from '../ui/Divider';
import { Input } from '../ui/Input';
import { Tabs } from '../ui/Tabs';
import { ErrorBanner, EmptyState, LoadingSpinner } from '../ui/Feedback';
import { FieldLabel, GroupLabel } from './SettingsPrimitives';
import { useGuildStore } from '../../stores/guildStore';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { useNavigate } from 'react-router';
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

const TABS: { value: Tab; label: string }[] = [
  { value: 'create', label: 'Create' },
  { value: 'join', label: 'Join' },
  { value: 'template', label: 'Template' },
];

export function CreateGuildModal({ onClose }: CreateGuildModalProps) {
  const guildScope = useCurrentAccountScope();
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('create');
  const [serverName, setServerName] = useState(`${user?.username || 'My'}'s building`);
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
    if (tab !== 'template') return;
    const controller = new AbortController();
    setTemplatesLoading(true);
    getApi()
      .get<GuildTemplate[]>('/templates', { signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setTemplates(res.data); })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(`Failed to load templates: ${extractApiError(err)}`);
      })
      .finally(() => { if (!controller.signal.aborted) setTemplatesLoading(false); });
    return () => controller.abort();
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

  const navigateToGuild = async (guild: ScopedGuild) => {
    const path = await guildLandingPath(guild);
    onClose();
    navigate(path);
  };

  const handleCreate = async () => {
    if (!serverName.trim() || !guildScope) return;
    setError('');
    setLoading(true);
    try {
      const guild = await useGuildStore.getState().createGuild(serverName.trim(), guildScope, iconDataUrl || undefined);
      await navigateToGuild(guild);
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Failed to create building');
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!inviteCode.trim() || !guildScope) return;
    setError('');
    setLoading(true);
    try {
      const code = inviteCode.trim().split('/').pop() || inviteCode.trim();
      const guild = await useGuildStore.getState().acceptInvite(code, guildScope);
      await navigateToGuild(guild);
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Failed to join building');
    } finally {
      setLoading(false);
    }
  };

  const handleApplyTemplate = async () => {
    if (!selectedTemplate || !templateGuildName.trim() || !guildScope) return;
    setError('');
    setLoading(true);
    try {
      const guild = await useGuildStore.getState().applyTemplate(selectedTemplate.id, templateGuildName.trim(), guildScope);
      await navigateToGuild(guild);
    } catch (err: unknown) {
      setError(extractApiError(err) || 'Failed to create building from template');
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

  const tabTitle = tab === 'create' ? 'Create a building' : tab === 'join' ? 'Join a building' : 'Start from a template';
  const tabSubtitle =
    tab === 'create'
      ? 'Your building is where you and your people hang out — give it a name and make it yours.'
      : tab === 'join'
        ? 'Have an invite? Drop it in below to land in an existing community.'
        : 'Skip the setup — pick a ready-made structure and rename it in one step.';

  const footerAction =
    tab === 'create' ? handleCreate : tab === 'join' ? handleJoin : handleApplyTemplate;
  const footerLabel = tab === 'create' ? 'Create' : tab === 'join' ? 'Join building' : 'Create from Template';

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="create-guild-modal-title"
      describedBy="create-guild-modal-description"
      showCloseButton
      panelClassName="w-[min(92vw,32rem)]"
    >
      <div className="flex max-h-[min(86dvh,42rem)] flex-col">
        <ModalHeader className="pb-4 pr-14">
          <ModalTitle id="create-guild-modal-title">{tabTitle}</ModalTitle>
          <ModalDescription id="create-guild-modal-description">{tabSubtitle}</ModalDescription>

          {/* Mode switch — a segmented control: the active step is a raised
              surface, never the emerald (that is reserved for the one action). */}
          <Tabs
            className="mt-4"
            label="How to add a building"
            items={TABS}
            value={tab}
            onChange={(next) => { setTab(next); setError(''); }}
            fill
          />
        </ModalHeader>
        <Divider />

        <ModalBody className="min-h-0 flex-1 overflow-auto py-5">
          {error && <ErrorBanner message={error} multiline className="mb-5" />}

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
                    'pc-well group flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-1',
                    'overflow-hidden rounded-[var(--radius-card)] p-2 text-center',
                    'transition-[box-shadow,color] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                    'focus-within:shadow-[var(--shadow-well),var(--focus-ring)]',
                    iconDragActive && 'shadow-[var(--shadow-well),0_0_0_1px_var(--accent-primary)]',
                  )}
                >
                  <input type="file" accept="image/*" className="sr-only" onChange={handleIconChange} aria-label="Building icon" />
                  {iconPreview ? (
                    <img src={iconPreview} alt="Building icon preview" className="h-full w-full object-cover" />
                  ) : (
                    <>
                      <Upload size={20} className="text-text-muted transition-colors group-hover:text-text-primary" />
                      <span className="text-section text-text-faint">
                        {iconDragActive ? 'Drop to upload' : 'Upload'}
                      </span>
                    </>
                  )}
                </label>
              </div>

              <label className="block">
                <FieldLabel>Building name</FieldLabel>
                <Input
                  type="text"
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  aria-label="Building name"
                />
              </label>
            </div>
          ) : tab === 'join' ? (
            <div className="space-y-5">
              <label className="block">
                <FieldLabel>Invite link</FieldLabel>
                <Input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="https://paracord.gg/hTKzmak"
                />
              </label>
              <div className="pc-well px-4 py-3">
                <GroupLabel>Invites look like</GroupLabel>
                <div className="mt-1.5 space-y-0.5 pc-mono text-meta text-text-muted">
                  <div>hTKzmak</div>
                  <div>https://paracord.gg/hTKzmak</div>
                </div>
              </div>
            </div>
          ) : (
            /* Template tab */
            <div className="space-y-4">
              {templatesLoading ? (
                <LoadingSpinner className="py-6" label="Loading templates…" />
              ) : templates.length === 0 ? (
                <EmptyState
                  icon={<LayoutTemplate size={20} />}
                  title="Save a building as a template first"
                  description="A template copies an existing building's channels and roles. Open that building's settings, save its structure, and it shows up here for every new building you start."
                  action={
                    <Button variant="ghost" onClick={() => { setTab('create'); setError(''); }}>
                      Build one from scratch
                    </Button>
                  }
                />
              ) : !selectedTemplate ? (
                <div className="max-h-60 space-y-2 overflow-y-auto">
                  {templates.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      className={cn(
                        'pc-raised pc-focusable w-full p-3 text-left',
                        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong',
                      )}
                      aria-label={`Use template ${t.name}`}
                      onClick={() => {
                        setSelectedTemplate(t);
                        setTemplateGuildName(`${user?.username || 'My'}'s building`);
                        setError('');
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="pc-display text-name text-text-primary">{t.name}</span>
                        <span className="pc-mono shrink-0 text-meta text-text-faint">
                          {t.template_data.channels.length} channels
                        </span>
                      </div>
                      {t.description && (
                        <p className="mt-1 line-clamp-2 text-meta text-text-secondary">{t.description}</p>
                      )}
                      <p className="mt-1 text-meta text-text-faint">
                        Used {t.usage_count} {t.usage_count === 1 ? 'time' : 'times'}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setSelectedTemplate(null); setError(''); }}
                  >
                    <ChevronLeft size={14} />
                    Back to templates
                  </Button>

                  <div className="pc-well p-3">
                    <p className="pc-display text-name text-text-primary">{selectedTemplate.name}</p>
                    {selectedTemplate.description && (
                      <p className="mt-1 text-meta leading-relaxed text-text-secondary">
                        {selectedTemplate.description}
                      </p>
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
                          <Chip
                            key={i}
                            size="sm"
                            style={{
                              color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : 'var(--text-secondary)',
                            }}
                          >
                            {r.name}
                          </Chip>
                        ))}
                      </div>
                    )}
                  </div>

                  <label className="block">
                    <FieldLabel>Building name</FieldLabel>
                    <Input
                      type="text"
                      aria-label="Template building name"
                      value={templateGuildName}
                      onChange={(e) => setTemplateGuildName(e.target.value)}
                    />
                  </label>
                </div>
              )}
            </div>
          )}
        </ModalBody>

        <Divider />
        <ModalFooter className="items-center gap-3 pt-4">
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
        </ModalFooter>
      </div>
    </Modal>
  );
}
