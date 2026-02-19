import { useState, useEffect, useCallback } from 'react';
import { Bot, RefreshCw, Trash2, Copy, Check, Key, ChevronDown, ChevronRight } from 'lucide-react';
import { botApi, type BotApplication, type BotGuildInstall } from '../api/bots';
import { cn } from '../lib/utils';
import { confirm } from '../stores/confirmStore';

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

  const fetchApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await botApi.list();
      setApps(data);
    } catch {
      setError('Failed to load bot applications');
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
    } catch {
      setError('Failed to create bot application');
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
    } catch {
      setError('Failed to update bot application');
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
    } catch {
      setError('Failed to delete bot application');
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
    } catch {
      setError('Failed to regenerate token');
    }
  };

  const copyToken = async (appId: string) => {
    const token = revealedTokens[appId];
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopiedId(appId);
      window.setTimeout(() => {
        setCopiedId((c) => (c === appId ? null : c));
      }, 1800);
    } catch {
      setError('Could not copy token to clipboard');
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
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedInviteId(app.id);
      window.setTimeout(() => {
        setCopiedInviteId((curr) => (curr === app.id ? null : curr));
      }, 1800);
    } catch {
      setError('Could not copy install link');
    }
  };

  const toggleInstalls = async (appId: string) => {
    if (expandedId === appId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(appId);
    if (!expandedInstalls[appId]) {
      try {
        const { data } = await botApi.listInstalls(appId);
        setExpandedInstalls((prev) => ({ ...prev, [appId]: data }));
      } catch {
        setError('Failed to load guild installs');
      }
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
    } catch {
      setError('Failed to load bot details');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <div className="flex items-center gap-3">
          <Bot size={24} className="text-accent-primary" />
          <h1 className="text-xl font-bold text-text-primary">Developer Portal</h1>
          <button
            onClick={() => void fetchApps()}
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-accent-danger/35 bg-accent-danger/10 px-4 py-2.5 text-sm font-medium text-accent-danger">
            {error}
          </div>
        )}

        {loading && <p className="text-sm text-text-muted">Loading...</p>}

        {/* Create new bot application */}
        <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
            Create Bot Application
          </h2>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <input
              className="input-field"
              placeholder="Bot name"
              value={newName}
              maxLength={80}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createApp();
              }}
            />
            <input
              className="input-field"
              placeholder="Description (optional)"
              value={newDescription}
              maxLength={400}
              onChange={(e) => setNewDescription(e.target.value)}
            />
            <button
              className="btn-primary h-[2.9rem] min-w-[7rem]"
              onClick={() => void createApp()}
            >
              Create
            </button>
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
                      <button className="btn-primary" onClick={() => void saveEdit(app.id)}>
                        Save
                      </button>
                      <button
                        className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                      onClick={() => startEditing(app)}
                    >
                      Edit
                    </button>
                  )}
                  <button
                    className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                    onClick={() => void regenerateToken(app.id)}
                  >
                    <Key size={13} />
                    Regen Token
                  </button>
                  <button
                    className={cn(
                      'inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary',
                      isExpanded && 'bg-bg-mod-strong text-text-primary'
                    )}
                    onClick={() => void toggleInstalls(app.id)}
                  >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    Guilds
                  </button>
                  <button
                    className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
                    onClick={() => void reloadAppDetails(app.id)}
                  >
                    <RefreshCw size={13} />
                    Reload
                  </button>
                  <button
                    className="ml-auto inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-accent-danger hover:bg-accent-danger/12"
                    onClick={() => void deleteApp(app.id)}
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>

                {/* Guild installs expansion */}
                {isExpanded && (
                  <div className="rounded-lg border border-border-subtle bg-bg-primary/40 p-3">
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
                            <span>
                              Added {new Date(install.created_at).toLocaleDateString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-text-muted">
                        Not installed in any guilds yet.
                      </p>
                    )}
                  </div>
                )}
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
