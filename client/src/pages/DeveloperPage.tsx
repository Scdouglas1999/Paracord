import { useState, useEffect, useCallback } from 'react';
import { Bot, RefreshCw, BookOpen } from 'lucide-react';
import { botApi, type BotApplication, type BotGuildInstall } from '../api/bots';
import { botStoreApi, type BotMetricsResult } from '../api/botStore';
import { commandApi } from '../api/commands';
import { extractApiError } from '../api/client';
import type { ApplicationCommand } from '../types/commands';
import { confirm } from '../stores/confirmStore';
import { Button } from '../components/ui/Button';
import { ErrorBanner, LoadingSpinner, EmptyState } from '../components/ui/Feedback';
import { writeClipboardText } from '../lib/clipboard';
import { CreateBotForm } from './developer/CreateBotForm';
import { BotAppCard } from './developer/BotAppCard';
import { BotAdvancedTabs, type AdvancedTab } from './developer/BotAdvancedTabs';
import { BotMetricsPanel } from './developer/BotMetricsPanel';

export function DeveloperPage() {
  const [apps, setApps] = useState<BotApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Token state
  const [revealedTokens, setRevealedTokens] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  // Install expansion
  const [expandedInstalls, setExpandedInstalls] = useState<Record<string, BotGuildInstall[]>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [metricsByApp, setMetricsByApp] = useState<Record<string, BotMetricsResult>>({});

  // Advanced sections (commands / intents / permissions)
  const [advancedTab, setAdvancedTab] = useState<Record<string, AdvancedTab>>({});
  const [commandsByApp, setCommandsByApp] = useState<Record<string, ApplicationCommand[]>>({});
  const [showCommandBuilder, setShowCommandBuilder] = useState<Record<string, boolean>>({});
  const [editingCommand, setEditingCommand] = useState<Record<string, ApplicationCommand | undefined>>({});
  const [pendingIntents, setPendingIntents] = useState<Record<string, number>>({});
  const [pendingPermissions, setPendingPermissions] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState<Record<string, boolean>>({});

  const fetchApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await botApi.list();
      setApps(data);
    } catch (err) {
      setError(`Failed to load bot applications: ${extractApiError(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

  const createApp = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const { data } = await botApi.create({
        name: trimmed,
        description: newDescription.trim() || undefined,
      });
      if (data.token) {
        setRevealedTokens((prev) => ({ ...prev, [data.id]: data.token! }));
      }
      setNewName('');
      setNewDescription('');
      await fetchApps();
    } catch (err) {
      setError(`Failed to create bot application: ${extractApiError(err)}`);
    }
  };

  const startEditing = (app: BotApplication) => {
    setEditingId(app.id);
    setEditName(app.name);
    setEditDescription(app.description || '');
  };

  const saveEdit = async (appId: string) => {
    setError(null);
    try {
      await botApi.update(appId, {
        name: editName.trim() || undefined,
        description: editDescription.trim() || undefined,
      });
      setEditingId(null);
      await fetchApps();
    } catch (err) {
      setError(`Failed to update bot application: ${extractApiError(err)}`);
    }
  };

  const deleteApp = async (appId: string) => {
    if (!(await confirm({ title: 'Delete bot application?', description: 'This cannot be undone.', confirmLabel: 'Delete', variant: 'danger' }))) return;
    setError(null);
    try {
      await botApi.delete(appId);
      setRevealedTokens((prev) => {
        const next = { ...prev };
        delete next[appId];
        return next;
      });
      await fetchApps();
    } catch (err) {
      setError(`Failed to delete bot application: ${extractApiError(err)}`);
    }
  };

  const regenerateToken = async (appId: string) => {
    if (!(await confirm({ title: 'Regenerate token?', description: 'The old token will stop working immediately.', confirmLabel: 'Regenerate' }))) return;
    setError(null);
    try {
      const { data } = await botApi.regenerateToken(appId);
      if (data.token) {
        setRevealedTokens((prev) => ({ ...prev, [appId]: data.token! }));
      }
      await fetchApps();
    } catch (err) {
      setError(`Failed to regenerate token: ${extractApiError(err)}`);
    }
  };

  const copyToken = async (appId: string) => {
    const token = revealedTokens[appId];
    if (!token) return;
    try {
      await writeClipboardText(token);
      setCopiedId(appId);
      window.setTimeout(() => {
        setCopiedId((c) => (c === appId ? null : c));
      }, 1800);
    } catch (err) {
      setError(`Could not copy token to clipboard: ${extractApiError(err)}`);
    }
  };

  const buildInstallUrl = (app: BotApplication) => {
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams({
      client_id: app.id,
      permissions: app.permissions,
    });
    if (app.redirect_uri) {
      params.set('redirect_uri', app.redirect_uri);
    }
    return `${window.location.origin}/app/oauth2/authorize?${params.toString()}`;
  };

  const copyInstallUrl = async (app: BotApplication) => {
    const inviteUrl = buildInstallUrl(app);
    if (!inviteUrl) return;
    try {
      await writeClipboardText(inviteUrl);
      setCopiedInviteId(app.id);
      window.setTimeout(() => {
        setCopiedInviteId((curr) => (curr === app.id ? null : curr));
      }, 1800);
    } catch (err) {
      setError(`Could not copy install link: ${extractApiError(err)}`);
    }
  };

  const toggleInstalls = async (appId: string) => {
    if (expandedId === appId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(appId);
    setAdvancedTab((prev) => ({ ...prev, [appId]: prev[appId] ?? 'guilds' }));
    if (!expandedInstalls[appId]) {
      try {
        const { data } = await botApi.listInstalls(appId);
        setExpandedInstalls((prev) => ({ ...prev, [appId]: data }));
      } catch (err) {
        setError(`Failed to load guild installs: ${extractApiError(err)}`);
      }
    }
  };

  const loadCommands = async (appId: string) => {
    try {
      const { data } = await commandApi.listGlobalCommands(appId);
      setCommandsByApp((prev) => ({ ...prev, [appId]: data }));
    } catch (err) {
      setCommandsByApp((prev) => ({ ...prev, [appId]: [] }));
      setError(`Failed to load commands: ${extractApiError(err)}`);
    }
  };

  const deleteCommand = async (appId: string, cmdId: string) => {
    if (!(await confirm({ title: 'Delete command?', description: 'This cannot be undone.', confirmLabel: 'Delete', variant: 'danger' }))) return;
    try {
      await commandApi.deleteGlobalCommand(appId, cmdId);
      setCommandsByApp((prev) => ({ ...prev, [appId]: (prev[appId] ?? []).filter((c) => c.id !== cmdId) }));
    } catch (err) {
      setError(`Failed to delete command: ${extractApiError(err)}`);
    }
  };

  const saveAppSettings = async (appId: string, app: BotApplication) => {
    setSavingSettings((prev) => ({ ...prev, [appId]: true }));
    try {
      const intents = pendingIntents[appId] ?? app.intents;
      const permissions = pendingPermissions[appId] ?? app.permissions;
      await botApi.update(appId, { intents, permissions });
      setApps((prev) => prev.map((a) => (a.id === appId ? { ...a, intents, permissions } : a)));
    } catch (err) {
      setError(`Failed to save bot settings: ${extractApiError(err)}`);
    } finally {
      setSavingSettings((prev) => ({ ...prev, [appId]: false }));
    }
  };

  const reloadAppDetails = async (appId: string) => {
    setError(null);
    try {
      const { data } = await botApi.get(appId);
      setApps((prev) => prev.map((app) => (app.id === appId ? data : app)));
      if (expandedId === appId) {
        const { data: installs } = await botApi.listInstalls(appId);
        setExpandedInstalls((prev) => ({ ...prev, [appId]: installs }));
      }
    } catch (err) {
      setError(`Failed to load bot details: ${extractApiError(err)}`);
    }
  };

  const loadMetrics = async (appId: string) => {
    try {
      const { data } = await botStoreApi.getDeveloperMetrics(appId);
      setMetricsByApp((prev) => ({ ...prev, [appId]: data }));
    } catch {
      // Keep page usable even if metrics endpoint fails.
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-6">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
              <Bot size={22} />
            </span>
            <div>
              <h1 className="font-display text-title text-text-primary">Developer portal</h1>
              <p className="mt-0.5 text-body text-text-secondary">
                Build bots and apps that automate and extend your server.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/api/docs"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-sm border border-border-subtle bg-transparent px-3 text-label font-semibold text-text-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
            >
              <BookOpen size={15} />
              API docs
            </a>
            <Button variant="outline" onClick={() => void fetchApps()} className="gap-2">
              <RefreshCw size={15} />
              Refresh
            </Button>
          </div>
        </header>

        {error && <ErrorBanner message={error} onRetry={() => void fetchApps()} />}
        {loading && <LoadingSpinner size="sm" label="Loading developer apps..." />}

        {/* Create new bot application */}
        <CreateBotForm
          name={newName}
          description={newDescription}
          onNameChange={setNewName}
          onDescriptionChange={setNewDescription}
          onCreate={() => void createApp()}
        />

        {/* Application list */}
        <div className="space-y-4">
          {apps.map((app) => {
            const isExpanded = expandedId === app.id;
            const tab = advancedTab[app.id] ?? 'guilds';
            const appIntents = pendingIntents[app.id] ?? app.intents;
            const appPermissions = pendingPermissions[app.id] ?? app.permissions;
            const intentsOrPermsDirty =
              (pendingIntents[app.id] !== undefined && pendingIntents[app.id] !== app.intents) ||
              (pendingPermissions[app.id] !== undefined && pendingPermissions[app.id] !== app.permissions);

            return (
              <BotAppCard
                key={app.id}
                app={app}
                isEditing={editingId === app.id}
                editName={editName}
                editDescription={editDescription}
                onEditNameChange={setEditName}
                onEditDescriptionChange={setEditDescription}
                token={revealedTokens[app.id]}
                copied={copiedId === app.id}
                copiedInvite={copiedInviteId === app.id}
                installUrl={buildInstallUrl(app)}
                isExpanded={isExpanded}
                onStartEditing={() => startEditing(app)}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={() => void saveEdit(app.id)}
                onRegenerateToken={() => void regenerateToken(app.id)}
                onToggleAdvanced={() => void toggleInstalls(app.id)}
                onReload={() => void reloadAppDetails(app.id)}
                onDelete={() => void deleteApp(app.id)}
                onCopyToken={() => void copyToken(app.id)}
                onCopyInstallUrl={() => void copyInstallUrl(app)}
                advanced={
                  <BotAdvancedTabs
                    app={app}
                    tab={tab}
                    installs={expandedInstalls[app.id]}
                    commands={commandsByApp[app.id]}
                    showCommandBuilder={!!showCommandBuilder[app.id]}
                    editingCommand={editingCommand[app.id]}
                    intents={appIntents}
                    permissions={appPermissions}
                    dirty={intentsOrPermsDirty}
                    saving={!!savingSettings[app.id]}
                    onTabChange={(t) => {
                      setAdvancedTab((prev) => ({ ...prev, [app.id]: t }));
                      if (t === 'commands' && !commandsByApp[app.id]) {
                        void loadCommands(app.id);
                      }
                    }}
                    onToggleCommandBuilder={() =>
                      setShowCommandBuilder((prev) => ({ ...prev, [app.id]: !prev[app.id] }))
                    }
                    onCommandSaved={() => {
                      setShowCommandBuilder((prev) => ({ ...prev, [app.id]: false }));
                      setEditingCommand((prev) => ({ ...prev, [app.id]: undefined }));
                      void loadCommands(app.id);
                    }}
                    onCommandCancel={() => {
                      setShowCommandBuilder((prev) => ({ ...prev, [app.id]: false }));
                      setEditingCommand((prev) => ({ ...prev, [app.id]: undefined }));
                    }}
                    onEditCommand={(cmd) => {
                      setEditingCommand((prev) => ({ ...prev, [app.id]: cmd }));
                      setShowCommandBuilder((prev) => ({ ...prev, [app.id]: true }));
                    }}
                    onDeleteCommand={(cmdId) => void deleteCommand(app.id, cmdId)}
                    onIntentsChange={(v) => setPendingIntents((prev) => ({ ...prev, [app.id]: v }))}
                    onPermissionsChange={(v) => setPendingPermissions((prev) => ({ ...prev, [app.id]: v }))}
                    onSaveSettings={() => void saveAppSettings(app.id, app)}
                  />
                }
                metrics={
                  <BotMetricsPanel
                    metrics={metricsByApp[app.id]}
                    onRefresh={() => void loadMetrics(app.id)}
                  />
                }
              />
            );
          })}

          {!loading && apps.length === 0 && (
            <div className="rounded-md border border-border-subtle bg-bg-secondary px-4 shadow-sm">
              <EmptyState
                icon={<Bot size={20} />}
                title="You haven't created any apps yet"
                description="Build a bot to automate moderation, post updates, or add slash commands to your server. Everything starts with an application."
                action={
                  <Button onClick={() => document.getElementById('new-bot-name')?.focus()}>
                    Create application
                  </Button>
                }
              />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
