import { useState, useEffect, useCallback, type KeyboardEvent } from 'react';
import { Bot, RefreshCw, BookOpen, Plus } from 'lucide-react';
import { useNavigate } from 'react-router';
import { botApi, type BotApplication, type BotGuildInstall } from '../api/bots';
import { botStoreApi, type BotMetricsResult } from '../api/botStore';
import { commandApi } from '../api/commands';
import { extractApiError } from '../api/client';
import type { ApplicationCommand } from '../types/commands';
import { confirm } from '../stores/confirmStore';
import {
  ErrorBanner,
  LoadingSpinner,
  NavRow,
  SettingsShell,
  type SettingsNavGroup,
} from '../components/ui';
import { useMobile } from '../hooks/useMobile';
import { writeClipboardText } from '../lib/clipboard';
import { CreateBotForm } from './developer/CreateBotForm';
import { BotAppCard } from './developer/BotAppCard';
import { BotAdvancedTabs, type AdvancedTab } from './developer/BotAdvancedTabs';
import { BotMetricsPanel } from './developer/BotMetricsPanel';

export function DeveloperPage() {
  const [apps, setApps] = useState<BotApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which section of the portal is open: an application's id, or the create
  // form when nothing is selected. The index in the shell drives this.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showIndex, setShowIndex] = useState(true);
  const navigate = useNavigate();
  const isMobile = useMobile();

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
      // The token is shown once — open the new app so it is on screen.
      setSelectedId(data.id);
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


  const selectedApp = apps.find((app) => app.id === selectedId) ?? null;
  const active = selectedApp ? selectedApp.id : 'new';

  const groups: SettingsNavGroup[] = [
    { items: [{ id: 'new', label: 'New application', icon: <Plus size={16} /> }] },
    ...(apps.length > 0
      ? [
          {
            label: 'Your apps',
            items: apps.map((app) => ({
              id: app.id,
              label: app.name,
              icon: <Bot size={16} />,
            })),
          },
        ]
      : []),
  ];

  const goHome = () => navigate('/app');

  // Escape closes the surface, which is what the shell's Esc hint promises.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    goHome();
  };

  const renderApp = (app: BotApplication) => {
    const isExpanded = expandedId === app.id;
    const tab = advancedTab[app.id] ?? 'guilds';
    const appIntents = pendingIntents[app.id] ?? app.intents;
    const appPermissions = pendingPermissions[app.id] ?? app.permissions;
    const intentsOrPermsDirty =
      (pendingIntents[app.id] !== undefined && pendingIntents[app.id] !== app.intents) ||
      (pendingPermissions[app.id] !== undefined && pendingPermissions[app.id] !== app.permissions);

    return (
      <BotAppCard
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
  };

  return (
    <SettingsShell
      label="Your applications"
      title="Developer portal"
      groups={groups}
      active={active}
      onSelect={(id) => {
        setSelectedId(id === 'new' ? null : id);
        setShowIndex(false);
      }}
      onClose={goHome}
      closeLabel="Back to home"
      isMobile={isMobile}
      showIndex={showIndex}
      onShowIndex={setShowIndex}
      onKeyDown={onKeyDown}
      indexFooter={
        <>
          <NavRow icon={<RefreshCw size={16} />} onClick={() => void fetchApps()}>
            Reload applications
          </NavRow>
          {/* The API reference lives outside the SPA, so it opens in its own
              tab; same row recipe as the index above it. */}
          <a
            href="/api/docs"
            target="_blank"
            rel="noreferrer"
            className="pc-focusable flex h-[var(--h-nav-row)] w-full select-none items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-label text-text-secondary transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
              <BookOpen size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate">API docs</span>
          </a>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {error && <ErrorBanner message={error} multiline onRetry={() => void fetchApps()} />}
        {loading && <LoadingSpinner size="sm" label="Loading developer apps..." />}
        {selectedApp ? renderApp(selectedApp) : (
          <CreateBotForm
            name={newName}
            description={newDescription}
            onNameChange={setNewName}
            onDescriptionChange={setNewDescription}
            onCreate={() => void createApp()}
          />
        )}
      </div>
    </SettingsShell>
  );
}
