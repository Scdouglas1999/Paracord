import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Trash2, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { templateApi, type GuildTemplate } from '../api/templates';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { ErrorBanner, LoadingSpinner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { confirm } from '../stores/confirmStore';
import { extractApiError } from '../api/client';

function channelTypeLabel(type: number): string {
  if (type === 2) return 'Voice';
  if (type === 4) return 'Category';
  if (type === 7) return 'Forum';
  if (type === 5) return 'Announcement';
  return 'Text';
}

export function TemplateGalleryPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const guilds = useGuildStore((s) => s.guilds);
  const [templates, setTemplates] = useState<GuildTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);
  const [applyName, setApplyName] = useState(`${user?.username || 'My'}'s server`);
  const [createGuildId, setCreateGuildId] = useState('');

  const ownedGuilds = useMemo(
    () => guilds.filter((guild) => guild.owner_id === user?.id),
    [guilds, user?.id],
  );

  useEffect(() => {
    if (ownedGuilds.length > 0 && !createGuildId) {
      setCreateGuildId(ownedGuilds[0].id);
    }
  }, [ownedGuilds, createGuildId]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  const refreshTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await templateApi.list();
      setTemplates(data);
      setSelectedTemplateId((prev) =>
        prev && data.some((template) => template.id === prev)
          ? prev
          : data[0]?.id ?? null
      );
    } catch (err) {
      setError(extractApiError(err) || 'Failed to load templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  const applyTemplate = async () => {
    if (!selectedTemplate || !applyName.trim()) return;
    setBusyTemplateId(selectedTemplate.id);
    setError(null);
    try {
      const { data: guild } = await templateApi.apply(selectedTemplate.id, applyName.trim());
      useGuildStore.getState().addGuild(guild);
      await useChannelStore.getState().fetchChannels(guild.id);
      navigate(`/app/guilds/${guild.id}`);
    } catch (err) {
      setError(extractApiError(err) || 'Failed to create server from template.');
    } finally {
      setBusyTemplateId(null);
    }
  };

  const deleteTemplate = async (templateId: string) => {
    const ok = await confirm({
      title: 'Delete template?',
      description: 'This permanently removes the template from the gallery.',
      confirmLabel: 'Delete template',
      variant: 'danger',
    });
    if (!ok) return;

    setBusyTemplateId(templateId);
    setError(null);
    try {
      await templateApi.remove(templateId);
      await refreshTemplates();
    } catch (err) {
      setError(extractApiError(err) || 'Failed to delete template.');
    } finally {
      setBusyTemplateId(null);
    }
  };

  const createFromGuild = async () => {
    if (!createGuildId) return;
    setBusyTemplateId(createGuildId);
    setError(null);
    try {
      await templateApi.createFromGuild(createGuildId);
      await refreshTemplates();
    } catch (err) {
      setError(extractApiError(err) || 'Failed to create template from selected guild.');
    } finally {
      setBusyTemplateId(null);
    }
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto rounded-2xl bg-bg-primary p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Template Gallery</h1>
          <p className="mt-1 text-sm text-text-muted">
            Browse templates, create new ones from your guilds, and launch servers instantly.
          </p>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void refreshTemplates()} />}

      <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/40 p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Create Template From Guild
        </div>
        {ownedGuilds.length === 0 ? (
          <p className="text-sm text-text-muted">You do not own any guilds yet.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Source guild"
              className="select-field min-w-[16rem]"
              value={createGuildId}
              onChange={(e) => setCreateGuildId(e.target.value)}
            >
              {ownedGuilds.map((guild) => (
                <option key={guild.id} value={guild.id}>
                  {guild.name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              className="inline-flex items-center gap-1.5"
              onClick={() => void createFromGuild()}
              disabled={busyTemplateId === createGuildId}
            >
              <Upload size={14} />
              {busyTemplateId === createGuildId ? 'Creating...' : 'Create Template'}
            </Button>
          </div>
        )}
      </div>

      {loading ? (
        <LoadingSpinner label="Loading templates..." className="py-10" />
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
          <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/30 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Templates
            </div>
            <div className="max-h-[min(66dvh,36rem)] space-y-1 overflow-y-auto scrollbar-thin">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  aria-label={`View template ${template.name}`}
                  onClick={() => setSelectedTemplateId(template.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selectedTemplateId === template.id
                      ? 'border-accent-primary/45 bg-accent-primary/12'
                      : 'border-border-subtle bg-bg-primary/40 hover:bg-bg-mod-subtle'
                  }`}
                >
                  <div className="truncate text-sm font-semibold text-text-primary">{template.name}</div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    {template.template_data.channels.length} channels | {template.template_data.roles.length} roles
                  </div>
                </button>
              ))}
              {templates.length === 0 && (
                <div className="rounded-lg border border-border-subtle bg-bg-primary/30 px-3 py-4 text-center text-sm text-text-muted">
                  No templates yet.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/30 p-4">
            {selectedTemplate ? (
              <div className="flex h-full flex-col">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">{selectedTemplate.name}</h2>
                    <p className="mt-1 text-sm text-text-muted">
                      {selectedTemplate.description || 'No description provided.'}
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      Used {selectedTemplate.usage_count} time{selectedTemplate.usage_count === 1 ? '' : 's'}
                    </p>
                  </div>
                  {selectedTemplate.creator_id === user?.id && (
                    <button
                      type="button"
                      aria-label={`Delete template ${selectedTemplate.name}`}
                      className="rounded-md border border-accent-danger/35 bg-accent-danger/10 px-2 py-1 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15"
                      onClick={() => void deleteTemplate(selectedTemplate.id)}
                      disabled={busyTemplateId === selectedTemplate.id}
                    >
                      <span className="inline-flex items-center gap-1">
                        <Trash2 size={12} />
                        {busyTemplateId === selectedTemplate.id ? 'Deleting...' : 'Delete'}
                      </span>
                    </button>
                  )}
                </div>

                <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className="rounded-lg border border-border-subtle bg-bg-primary/35 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      Channels
                    </div>
                    <div className="max-h-64 space-y-1 overflow-y-auto text-sm scrollbar-thin">
                      {selectedTemplate.template_data.channels
                        .slice()
                        .sort((a, b) => a.position - b.position)
                        .map((channel, index) => (
                          <div
                            key={`${channel.name}-${index}`}
                            className="rounded-md border border-border-subtle/50 bg-bg-mod-subtle/30 px-2 py-1.5 text-text-secondary"
                          >
                            <span className="font-medium text-text-primary">{channel.name}</span>
                            <span className="ml-2 text-xs text-text-muted">
                              {channelTypeLabel(channel.type)}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-subtle bg-bg-primary/35 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      Roles
                    </div>
                    <div className="max-h-64 space-y-1 overflow-y-auto text-sm scrollbar-thin">
                      {selectedTemplate.template_data.roles.map((role, index) => (
                        <div
                          key={`${role.name}-${index}`}
                          className="rounded-md border border-border-subtle/50 bg-bg-mod-subtle/30 px-2 py-1.5 text-text-primary"
                        >
                          {role.name}
                        </div>
                      ))}
                      {selectedTemplate.template_data.roles.length === 0 && (
                        <div className="rounded-md border border-border-subtle/50 bg-bg-mod-subtle/30 px-2 py-2 text-xs text-text-muted">
                          No custom roles in this template.
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <input
                    aria-label="New server name"
                    className="input-field min-w-[16rem] flex-1"
                    value={applyName}
                    onChange={(e) => setApplyName(e.target.value)}
                    placeholder="New server name"
                  />
                  <Button
                    type="button"
                    onClick={() => void applyTemplate()}
                    disabled={busyTemplateId === selectedTemplate.id || !applyName.trim()}
                  >
                    {busyTemplateId === selectedTemplate.id ? 'Creating...' : 'Create From Template'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-text-muted">
                <FileText size={26} />
                <p className="text-sm">Select a template to view details.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
