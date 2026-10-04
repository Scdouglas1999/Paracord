import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useState } from 'react';
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
import { useNavigate } from 'react-router';
import { cn } from '../../lib/utils';
import {
  defaultServerName,
  useAddServerActions,
  useGuildTemplates,
  useServerIcon,
  type GuildTemplate,
} from '../ix/dock/useAddServer';

interface CreateGuildModalProps {
  initialTab?: Tab;
  onClose: () => void;
}

type Tab = 'create' | 'join' | 'template';

const TABS: { value: Tab; label: string }[] = [
  { value: 'create', label: 'Create' },
  { value: 'join', label: 'Join' },
  { value: 'template', label: 'Template' },
];

export function CreateGuildModal({ onClose, initialTab = 'create' }: CreateGuildModalProps) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [serverName, setServerName] = useState(defaultServerName(user?.username));
  const [inviteCode, setInviteCode] = useState('');
  const [iconDragActive, setIconDragActive] = useState(false);

  // The rules (what a name is, how an invite is read, what a refused picture
  // says) are shared with the Add a server sheet: components/ix/dock/useAddServer.
  const icon = useServerIcon();
  const { templates, loading: templatesLoading, error: templatesError } = useGuildTemplates(tab === 'template');
  const [selectedTemplate, setSelectedTemplate] = useState<GuildTemplate | null>(null);
  const [templateGuildName, setTemplateGuildName] = useState('');
  const actions = useAddServerActions((path) => {
    onClose();
    navigate(path);
  });
  const loading = actions.loading;
  const error =
    actions.error ?? (tab === 'create' ? icon.error : null) ?? (tab === 'template' ? templatesError : null) ?? '';
  const iconPreview = icon.preview;

  const processIconFile = icon.choose;
  const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processIconFile(e.target.files?.[0]);
  };

  const handleCreate = () => actions.create(serverName, icon.dataUrl);
  const handleJoin = () => actions.join(inviteCode);
  const handleApplyTemplate = () =>
    selectedTemplate ? actions.fromTemplate(selectedTemplate.id, templateGuildName) : Promise.resolve();

  const channelIcon = (type: number) => {
    switch (type) {
      case 2: return <Volume2 size={14} className="shrink-0 text-channel-icon" />;
      case 4: return <Folder size={14} className="shrink-0 text-channel-icon" />;
      default: return <Hash size={14} className="shrink-0 text-channel-icon" />;
    }
  };

  const tabTitle = tab === 'create' ? 'Create a server' : tab === 'join' ? 'Join a server' : 'Start from a template';
  const tabSubtitle =
    tab === 'create'
      ? 'Your server is where you and your people hang out — give it a name and make it yours.'
      : tab === 'join'
        ? 'Have an invite? Drop it in below to land in an existing community.'
        : 'Skip the setup — pick a ready-made structure and rename it in one step.';

  const footerAction =
    tab === 'create' ? handleCreate : tab === 'join' ? handleJoin : handleApplyTemplate;
  const footerLabel = tab === 'create' ? 'Create' : tab === 'join' ? 'Join server' : 'Create from Template';

  return (
    <Modal
      open
      onClose={onClose}
      labeledBy="create-guild-modal-title"
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
            label="How to add a server"
            items={TABS}
            value={tab}
            onChange={(next) => { setTab(next); actions.clearError(); }}
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
                    'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                    'focus-within:shadow-[var(--shadow-well),var(--focus-ring)]',
                    iconDragActive && 'shadow-[var(--shadow-well),0_0_0_1px_var(--accent-primary)]',
                  )}
                >
                  <input type="file" accept="image/*" className="sr-only" onChange={handleIconChange} aria-label="Server icon" />
                  {iconPreview ? (
                    <img src={iconPreview} alt="Server icon preview" className="h-full w-full object-cover" />
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
                <FieldLabel>Server name</FieldLabel>
                <Input
                  type="text"
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  aria-label="Server name"
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
                  title="Save a server as a template first"
                  description="A template copies an existing server's channels and roles. Open that server's settings, save its structure, and it shows up here for every new server you start."
                  action={
                    <Button variant="ghost" onClick={() => { setTab('create'); actions.clearError(); }}>
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
                        setTemplateGuildName(`${user?.username || 'My'}'s server`);
                        actions.clearError();
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="pc-display text-name text-text-primary">{t.name}</span>
                        <span className="glass-instrument shrink-0 text-meta text-text-faint">
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
                    onClick={() => { setSelectedTemplate(null); actions.clearError(); }}
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
                    <FieldLabel>Server name</FieldLabel>
                    <Input
                      type="text"
                      aria-label="Template server name"
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
