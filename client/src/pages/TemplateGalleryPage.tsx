import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Trash2, Upload, Hash, Volume2, Megaphone, Folder, MessagesSquare, Search, Shield } from 'lucide-react';
import { useNavigate } from 'react-router';
import { templateApi, type GuildTemplate } from '../api/templates';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { ErrorBanner, LoadingSpinner, EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Input';
import { confirm } from '../stores/confirmStore';
import { extractApiError } from '../api/client';

function channelTypeLabel(type: number): string {
  if (type === 2) return 'Voice';
  if (type === 4) return 'Category';
  if (type === 7) return 'Forum';
  if (type === 5) return 'Announcement';
  return 'Text';
}

function channelTypeIcon(type: number) {
  if (type === 2) return Volume2;
  if (type === 4) return Folder;
  if (type === 5) return Megaphone;
  return Hash;
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
  const [query, setQuery] = useState('');

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

  const visibleTemplates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => t.name.toLowerCase().includes(q));
  }, [templates, query]);

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
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      {/* Solid header (no gradient hero) */}
      <header className="shrink-0 border-b border-border-subtle bg-bg-secondary px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
              <FileText size={19} />
            </span>
            <div>
              <h1 className="font-display text-heading text-text-primary">Template gallery</h1>
              <p className="text-meta text-text-muted">
                Launch a server pre-built with channels and roles, or save one of your own as a blueprint.
              </p>
            </div>
          </div>

          {ownedGuilds.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="template-source-guild" className="sr-only">
                Source guild
              </label>
              <Select
                id="template-source-guild"
                aria-label="Source guild"
                className="min-w-[13rem]"
                value={createGuildId}
                onChange={(e) => setCreateGuildId(e.target.value)}
              >
                {ownedGuilds.map((guild) => (
                  <option key={guild.id} value={guild.id}>
                    {guild.name}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="secondary"
                className="shrink-0 gap-1.5"
                onClick={() => void createFromGuild()}
                disabled={busyTemplateId === createGuildId}
              >
                <Upload size={15} />
                {busyTemplateId === createGuildId ? 'Creating...' : 'Create Template'}
              </Button>
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden p-4 sm:p-6">
        {error && <ErrorBanner message={error} className="mb-4" onRetry={() => void refreshTemplates()} />}

        {loading ? (
          <LoadingSpinner label="Loading templates..." className="py-16" />
        ) : (
          <div className="grid h-full min-h-0 grid-cols-1 gap-5 lg:grid-cols-[19rem_1fr]">
            {/* List pane */}
            <div className="flex min-h-0 flex-col">
              <div className="relative mb-3">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                <label htmlFor="template-search" className="sr-only">
                  Search templates
                </label>
                <Input
                  id="template-search"
                  type="text"
                  placeholder="Search templates"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                {templates.length === 0 ? (
                  <EmptyState
                    icon={<FileText size={20} />}
                    title="You haven't saved a template yet"
                    description="Turn one of your spaces into a template and it'll show up here, ready to spin up again — channels, roles, and all — in seconds."
                  />
                ) : visibleTemplates.length === 0 ? (
                  <EmptyState
                    icon={<Search size={20} />}
                    title="No matches"
                    description={`Nothing is named like "${query.trim()}". Try a different search.`}
                  />
                ) : (
                  <div className="flex flex-col gap-1">
                    {visibleTemplates.map((template) => {
                      const active = selectedTemplateId === template.id;
                      return (
                        <button
                          key={template.id}
                          type="button"
                          aria-label={`View template ${template.name}`}
                          aria-pressed={active}
                          onClick={() => setSelectedTemplateId(template.id)}
                          className={`w-full rounded-sm px-3 py-2.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] ${
                            active
                              ? 'bg-accent-tint text-text-primary'
                              : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                          }`}
                        >
                          <div className="truncate text-label font-semibold text-text-primary">{template.name}</div>
                          <div className="mt-0.5 text-meta tabular-nums text-text-muted">
                            {template.template_data.channels.length} channels | {template.template_data.roles.length} roles
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Detail pane */}
            <div className="min-h-0 rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
              {selectedTemplate ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-display text-title text-text-primary">{selectedTemplate.name}</h2>
                      <p className="mt-1 text-body text-text-secondary">
                        {selectedTemplate.description || 'No description provided.'}
                      </p>
                      <p className="mt-1.5 text-meta tabular-nums text-text-muted">
                        Used {selectedTemplate.usage_count} time{selectedTemplate.usage_count === 1 ? '' : 's'}
                      </p>
                    </div>
                    {selectedTemplate.creator_id === user?.id && (
                      <button
                        type="button"
                        aria-label={`Delete template ${selectedTemplate.name}`}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-accent-danger/35 px-2.5 py-1.5 text-meta font-semibold text-accent-danger outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-danger hover:text-text-on-danger focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50"
                        onClick={() => void deleteTemplate(selectedTemplate.id)}
                        disabled={busyTemplateId === selectedTemplate.id}
                      >
                        <Trash2 size={13} />
                        {busyTemplateId === selectedTemplate.id ? 'Deleting...' : 'Delete'}
                      </button>
                    )}
                  </div>

                  <div className="mt-5 grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-2">
                    <div className="flex min-h-0 flex-col">
                      <div className="mb-2 flex items-center gap-1.5 text-section uppercase text-text-muted">
                        <MessagesSquare size={13} />
                        Channels — {selectedTemplate.template_data.channels.length}
                      </div>
                      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-sm bg-bg-tertiary p-2 scrollbar-thin">
                        {selectedTemplate.template_data.channels
                          .slice()
                          .sort((a, b) => a.position - b.position)
                          .map((channel, index) => {
                            const Icon = channelTypeIcon(channel.type);
                            return (
                              <div
                                key={`${channel.name}-${index}`}
                                className="flex items-center gap-2 rounded-sm px-2 py-1.5"
                              >
                                <Icon size={14} className="shrink-0 text-text-muted" />
                                <span className="min-w-0 flex-1 truncate text-label text-text-primary">{channel.name}</span>
                                <span className="shrink-0 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta font-semibold text-text-secondary">
                                  {channelTypeLabel(channel.type)}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    <div className="flex min-h-0 flex-col">
                      <div className="mb-2 flex items-center gap-1.5 text-section uppercase text-text-muted">
                        <Shield size={13} />
                        Roles — {selectedTemplate.template_data.roles.length}
                      </div>
                      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-sm bg-bg-tertiary p-2 scrollbar-thin">
                        {selectedTemplate.template_data.roles.map((role, index) => (
                          <div
                            key={`${role.name}-${index}`}
                            className="flex items-center gap-2 rounded-sm px-2 py-1.5"
                          >
                            <Shield size={14} className="shrink-0 text-text-muted" />
                            <span className="min-w-0 flex-1 truncate text-label text-text-primary">{role.name}</span>
                          </div>
                        ))}
                        {selectedTemplate.template_data.roles.length === 0 && (
                          <div className="px-2 py-2 text-meta leading-relaxed text-text-muted">
                            This template ships with only the default @everyone role.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
                    <label htmlFor="template-apply-name" className="sr-only">
                      New server name
                    </label>
                    <Input
                      id="template-apply-name"
                      aria-label="New server name"
                      className="min-w-[14rem] flex-1"
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
                <EmptyState
                  icon={<FileText size={20} />}
                  title="Choose a template to preview it"
                  description="Pick a template from the list to see the channels and roles it creates, then launch a new server from it."
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
