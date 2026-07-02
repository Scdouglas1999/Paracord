import { useState, useEffect, useCallback } from 'react';
import { Bot, RefreshCw, Trash2, Copy, Check, Key, ChevronDown, ChevronRight, Star, BookOpen, Terminal, Shield, Zap } from 'lucide-react';
import { botApi, type BotApplication, type BotGuildInstall } from '../api/bots';
import { botStoreApi, type BotMetricsResult } from '../api/botStore';
import { commandApi } from '../api/commands';
import { extractApiError } from '../api/client';
import type { ApplicationCommand } from '../types/commands';
import { cn } from '../lib/utils';
import { confirm } from '../stores/confirmStore';
import { ErrorBanner, LoadingSpinner } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { CommandBuilder } from '../components/developer/CommandBuilder';
import { IntentSelector } from '../components/developer/IntentSelector';
import { PermissionCalculator } from '../components/developer/PermissionCalculator';
import { writeClipboardText } from '../lib/clipboard';

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
  type AdvancedTab = 'guilds' | 'commands' | 'intents' | 'permissions';
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
        <div className="flex items-center gap-3">
          <Bot size={24} className="text-accent-primary" />
          <h1 className="text-xl font-bold text-text-primary">Developer Portal</h1>
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/api/docs"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
            >
              <BookOpen size={14} />
              API Docs
            </a>
            <button
              type="button"
              onClick={() => void fetchApps()}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </div>

        {error && <ErrorBanner message={error} onRetry={() => void fetchApps()} />}
        {loading && <LoadingSpinner size="sm" label="Loading developer apps..." />}

        {/* Create new bot application */}
        <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
            Create Bot Application
          </h2>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <label htmlFor="new-bot-name" className="sr-only">
              Bot name
            </label>
            <input
              id="new-bot-name"
              className="input-field"
              placeholder="Bot name"
              value={newName}
              maxLength={80}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createApp();
              }}
            />
            <label htmlFor="new-bot-description" className="sr-only">
              Description
            </label>
            <input
              id="new-bot-description"
              className="input-field"
              placeholder="Description (optional)"
              value={newDescription}
              maxLength={400}
              onChange={(e) => setNewDescription(e.target.value)}
            />
            <Button
              className="h-[2.9rem] min-w-[7rem]"
              onClick={() => void createApp()}
            >
              Create
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            A bot user account will be created automatically. The token is shown only once on creation -- copy it immediately.
          </p>
        </div>

        {/* Application list */}
        <div className="space-y-4">
          {apps.map((app) => {
            const isEditing = editingId === app.id;
            const token = revealedTokens[app.id];
            const isExpanded = expandedId === app.id;
            const installs = expandedInstalls[app.id];
            const installUrl = buildInstallUrl(app);

            const metrics = metricsByApp[app.id];
            return (
              <div
                key={app.id}
                className="rounded-xl border border-border-subtle bg-bg-secondary/60 p-5 space-y-3"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-primary/15 text-accent-primary">
                    <Bot size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="space-y-2">
                        <input
                          className="input-field"
                          value={editName}
                          maxLength={80}
                          onChange={(e) => setEditName(e.target.value)}
                          autoFocus
                        />
                        <input
                          className="input-field"
                          value={editDescription}
                          maxLength={400}
                          placeholder="Description"
                          onChange={(e) => setEditDescription(e.target.value)}
                        />
                      </div>
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-text-primary">{app.name}</p>
                        {app.description && (
                          <p className="mt-0.5 text-xs text-text-muted">{app.description}</p>
                        )}
                      </>
                    )}
                    <p className="mt-1 text-xs text-text-muted">
                      ID: {app.id} &middot; Bot User: {app.bot_user_id} &middot; Created{' '}
                      {new Date(app.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                {/* Token area */}
                <div className="rounded-lg border border-border-subtle bg-bg-primary/55 px-3 py-2">
                  {token ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="flex-1 break-all text-xs text-text-secondary">{token}</code>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                        onClick={() => void copyToken(app.id)}
                      >
                        {copiedId === app.id ? (
                          <>
                            <Check size={12} /> Copied
                          </>
                        ) : (
                          <>
                            <Copy size={12} /> Copy
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-text-muted">
                      Token hidden. Regenerate to reveal a new token.
                    </span>
                  )}
                </div>

                <div className="rounded-lg border border-border-subtle bg-bg-primary/55 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="flex-1 break-all text-xs text-text-secondary">{installUrl}</code>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                      onClick={() => void copyInstallUrl(app)}
                    >
                      {copiedInviteId === app.id ? (
                        <>
                          <Check size={12} /> Copied
                        </>
                      ) : (
                        <>
                          <Copy size={12} /> Copy Link
                        </>
                      )}
                    </button>
                    <a
                      href={installUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                    >
                      Open
                    </a>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2">
                  {isEditing ? (
                    <>
                      <Button onClick={() => void saveEdit(app.id)}>
                        Save
                      </Button>
                      <button
                        type="button"
                        className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                      onClick={() => startEditing(app)}
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                    onClick={() => void regenerateToken(app.id)}
                  >
                    <Key size={13} />
                    Regen Token
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary',
                      isExpanded && 'bg-bg-mod-strong text-text-primary'
                    )}
                    onClick={() => void toggleInstalls(app.id)}
                  >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    Advanced
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                    onClick={() => void reloadAppDetails(app.id)}
                  >
                    <RefreshCw size={13} />
                    Reload
                  </button>
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-accent-danger hover:bg-accent-danger/12"
                    onClick={() => void deleteApp(app.id)}
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>

                {/* Advanced expansion with tabs */}
                {isExpanded && (() => {
                  const tab = advancedTab[app.id] ?? 'guilds';
                  const appCommands = commandsByApp[app.id];
                  const appIntents = pendingIntents[app.id] ?? app.intents;
                  const appPermissions = pendingPermissions[app.id] ?? app.permissions;
                  const intentsOrPermsDirty =
                    (pendingIntents[app.id] !== undefined && pendingIntents[app.id] !== app.intents) ||
                    (pendingPermissions[app.id] !== undefined && pendingPermissions[app.id] !== app.permissions);

                  return (
                    <div className="rounded-lg border border-border-subtle bg-bg-primary/40">
                      {/* Tab bar */}
                      <div className="flex border-b border-border-subtle">
                        {((['guilds', 'commands', 'intents', 'permissions'] as const)).map((t) => (
                          <button
                            type="button"
                            key={t}
                            className={cn(
                              'flex items-center gap-1.5 px-3 py-2 text-xs font-semibold capitalize text-text-secondary transition-colors hover:text-text-primary',
                              tab === t && 'border-b-2 border-accent-primary text-accent-primary',
                            )}
                            onClick={() => {
                              setAdvancedTab((prev) => ({ ...prev, [app.id]: t }));
                              if (t === 'commands' && !commandsByApp[app.id]) {
                                void loadCommands(app.id);
                              }
                            }}
                          >
                            {t === 'guilds' && <ChevronRight size={12} />}
                            {t === 'commands' && <Terminal size={12} />}
                            {t === 'intents' && <Zap size={12} />}
                            {t === 'permissions' && <Shield size={12} />}
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </button>
                        ))}
                      </div>

                      <div className="p-3">
                        {/* Guilds tab */}
                        {tab === 'guilds' && (
                          <>
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                              Installed Guilds
                            </p>
                            {installs && installs.length > 0 ? (
                              <div className="space-y-1.5">
                                {installs.map((install) => (
                                  <div
                                    key={install.guild_id}
                                    className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle/60 px-3 py-2 text-xs text-text-secondary"
                                  >
                                    <span className="flex-1">Guild {install.guild_id}</span>
                                    <span>Perms: {install.permissions}</span>
                                    <span>Added {new Date(install.created_at).toLocaleDateString()}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-text-muted">Not installed in any guilds yet.</p>
                            )}
                          </>
                        )}

                        {/* Commands tab */}
                        {tab === 'commands' && (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                                Global Commands
                              </p>
                              <Button
                                size="sm"
                                onClick={() => setShowCommandBuilder((prev) => ({ ...prev, [app.id]: !prev[app.id] }))}
                              >
                                {showCommandBuilder[app.id] ? 'Cancel' : '+ New Command'}
                              </Button>
                            </div>

                            {showCommandBuilder[app.id] && (
                              <CommandBuilder
                                appId={app.id}
                                editingCommand={editingCommand[app.id]}
                                onSaved={() => {
                                  setShowCommandBuilder((prev) => ({ ...prev, [app.id]: false }));
                                  setEditingCommand((prev) => ({ ...prev, [app.id]: undefined }));
                                  void loadCommands(app.id);
                                }}
                                onCancel={() => {
                                  setShowCommandBuilder((prev) => ({ ...prev, [app.id]: false }));
                                  setEditingCommand((prev) => ({ ...prev, [app.id]: undefined }));
                                }}
                              />
                            )}

                            {appCommands === undefined ? (
                              <LoadingSpinner size="sm" label="Loading commands..." />
                            ) : appCommands.length === 0 ? (
                              <p className="text-xs text-text-muted">No global commands registered yet.</p>
                            ) : (
                              <div className="space-y-1.5">
                                {appCommands.map((cmd) => (
                                  <div
                                    key={cmd.id}
                                    className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle/60 px-3 py-2 text-xs"
                                  >
                                    <code className="font-semibold text-text-primary">/{cmd.name}</code>
                                    <span className="flex-1 text-text-muted">{cmd.description}</span>
                                    <button
                                      type="button"
                                      className="text-text-secondary hover:text-text-primary"
                                      onClick={() => {
                                        setEditingCommand((prev) => ({ ...prev, [app.id]: cmd }));
                                        setShowCommandBuilder((prev) => ({ ...prev, [app.id]: true }));
                                      }}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      className="text-accent-danger hover:text-accent-danger/80"
                                      onClick={() => void deleteCommand(app.id, cmd.id)}
                                      aria-label={`Delete command ${cmd.name}`}
                                      title={`Delete command ${cmd.name}`}
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Intents tab */}
                        {tab === 'intents' && (
                          <div className="space-y-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                              Gateway Intents
                            </p>
                            <IntentSelector
                              value={appIntents}
                              onChange={(v) => setPendingIntents((prev) => ({ ...prev, [app.id]: v }))}
                            />
                            {intentsOrPermsDirty && (
                              <Button
                                size="sm"
                                onClick={() => void saveAppSettings(app.id, app)}
                                disabled={savingSettings[app.id]}
                              >
                                {savingSettings[app.id] ? 'Saving...' : 'Save Changes'}
                              </Button>
                            )}
                          </div>
                        )}

                        {/* Permissions tab */}
                        {tab === 'permissions' && (
                          <div className="space-y-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                              Default Bot Permissions
                            </p>
                            <PermissionCalculator
                              value={appPermissions}
                              onChange={(v) => setPendingPermissions((prev) => ({ ...prev, [app.id]: v }))}
                            />
                            {intentsOrPermsDirty && (
                              <Button
                                size="sm"
                                onClick={() => void saveAppSettings(app.id, app)}
                                disabled={savingSettings[app.id]}
                              >
                                {savingSettings[app.id] ? 'Saving...' : 'Save Changes'}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                <div className="rounded-lg border border-border-subtle bg-bg-primary/40 px-3 py-2.5 text-xs text-text-secondary">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold uppercase tracking-wide text-text-secondary">Metrics (30d)</span>
                    <button
                      type="button"
                      className="rounded-md border border-border-subtle px-2 py-0.5 text-[11px] font-semibold hover:bg-bg-mod-strong"
                      onClick={() => void loadMetrics(app.id)}
                    >
                      Refresh Metrics
                    </button>
                  </div>
                  {metrics ? (
                    <div className="space-y-1.5">
                      <div>
                        Installs: <span className="font-semibold text-text-primary">{metrics.install_count}</span>
                        {' · '}
                        Active Guilds: <span className="font-semibold text-text-primary">{metrics.active_guild_count}</span>
                      </div>
                      <div className="inline-flex items-center gap-1.5">
                        <Star size={12} className="text-accent-warning" />
                        {metrics.average_rating.toFixed(1)} ({metrics.review_count} reviews)
                      </div>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {metrics.metrics_30d.map((bucket) => (
                          <span key={bucket.event_type} className="rounded-full border border-border-subtle px-2 py-0.5 text-[11px]">
                            {bucket.event_type}: {bucket.count}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-text-muted">No metrics loaded yet.</div>
                  )}
                </div>
              </div>
            );
          })}

          {!loading && apps.length === 0 && (
            <div className="rounded-xl border border-border-subtle bg-bg-secondary/40 px-6 py-10 text-center">
              <Bot size={36} className="mx-auto mb-3 text-text-muted" />
              <p className="text-sm text-text-muted">
                No bot applications yet. Create one to get started.
              </p>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
