import { ChevronRight, Shield, Terminal, Trash2, Zap } from 'lucide-react';
import type { BotApplication, BotGuildInstall } from '../../api/bots';
import type { ApplicationCommand } from '../../types/commands';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import { LoadingSpinner } from '../../components/ui/Feedback';
import { CommandBuilder } from '../../components/developer/CommandBuilder';
import { IntentSelector } from '../../components/developer/IntentSelector';
import { PermissionCalculator } from '../../components/developer/PermissionCalculator';

export type AdvancedTab = 'guilds' | 'commands' | 'intents' | 'permissions';

interface BotAdvancedTabsProps {
  app: BotApplication;
  tab: AdvancedTab;
  installs: BotGuildInstall[] | undefined;
  commands: ApplicationCommand[] | undefined;
  showCommandBuilder: boolean;
  editingCommand: ApplicationCommand | undefined;
  intents: number;
  permissions: string;
  dirty: boolean;
  saving: boolean;
  onTabChange: (tab: AdvancedTab) => void;
  onToggleCommandBuilder: () => void;
  onCommandSaved: () => void;
  onCommandCancel: () => void;
  onEditCommand: (command: ApplicationCommand) => void;
  onDeleteCommand: (commandId: string) => void;
  onIntentsChange: (value: number) => void;
  onPermissionsChange: (value: string) => void;
  onSaveSettings: () => void;
}

export function BotAdvancedTabs({
  app,
  tab,
  installs,
  commands,
  showCommandBuilder,
  editingCommand,
  intents,
  permissions,
  dirty,
  saving,
  onTabChange,
  onToggleCommandBuilder,
  onCommandSaved,
  onCommandCancel,
  onEditCommand,
  onDeleteCommand,
  onIntentsChange,
  onPermissionsChange,
  onSaveSettings,
}: BotAdvancedTabsProps) {
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
            onClick={() => onTabChange(t)}
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
                onClick={onToggleCommandBuilder}
              >
                {showCommandBuilder ? 'Cancel' : '+ New Command'}
              </Button>
            </div>

            {showCommandBuilder && (
              <CommandBuilder
                appId={app.id}
                editingCommand={editingCommand}
                onSaved={onCommandSaved}
                onCancel={onCommandCancel}
              />
            )}

            {commands === undefined ? (
              <LoadingSpinner size="sm" label="Loading commands..." />
            ) : commands.length === 0 ? (
              <p className="text-xs text-text-muted">No global commands registered yet.</p>
            ) : (
              <div className="space-y-1.5">
                {commands.map((cmd) => (
                  <div
                    key={cmd.id}
                    className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle/60 px-3 py-2 text-xs"
                  >
                    <code className="font-semibold text-text-primary">/{cmd.name}</code>
                    <span className="flex-1 text-text-muted">{cmd.description}</span>
                    <button
                      type="button"
                      className="text-text-secondary hover:text-text-primary"
                      onClick={() => onEditCommand(cmd)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-accent-danger hover:text-accent-danger/80"
                      onClick={() => onDeleteCommand(cmd.id)}
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
              value={intents}
              onChange={onIntentsChange}
            />
            {dirty && (
              <Button
                size="sm"
                onClick={onSaveSettings}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Changes'}
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
              value={permissions}
              onChange={onPermissionsChange}
            />
            {dirty && (
              <Button
                size="sm"
                onClick={onSaveSettings}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
