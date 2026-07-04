import { Server, Shield, Terminal, Trash2, Zap } from 'lucide-react';
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

const TAB_ICON = {
  guilds: Server,
  commands: Terminal,
  intents: Zap,
  permissions: Shield,
} as const;

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
    <div className="overflow-hidden rounded-sm border border-border-subtle bg-bg-tertiary">
      {/* Tab bar */}
      <div className="flex border-b border-border-subtle" role="tablist">
        {(['guilds', 'commands', 'intents', 'permissions'] as const).map((t) => {
          const Icon = TAB_ICON[t];
          const active = tab === t;
          return (
            <button
              type="button"
              key={t}
              role="tab"
              aria-selected={active}
              className={cn(
                'relative flex items-center gap-1.5 px-3.5 py-2.5 text-label font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                active ? 'text-accent-primary' : 'text-text-secondary hover:text-text-primary',
              )}
              onClick={() => onTabChange(t)}
            >
              <Icon size={14} />
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent-primary" />}
            </button>
          );
        })}
      </div>

      <div className="p-4">
        {/* Guilds tab */}
        {tab === 'guilds' && (
          <>
            <p className="mb-3 text-section uppercase text-text-secondary">Installed guilds</p>
            {installs && installs.length > 0 ? (
              <div className="space-y-2">
                {installs.map((install) => (
                  <div
                    key={install.guild_id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border border-border-subtle bg-bg-secondary px-3 py-2 text-body text-text-secondary"
                  >
                    <span className="flex-1 font-code text-meta text-text-primary">Guild {install.guild_id}</span>
                    <span className="text-meta">Perms {install.permissions}</span>
                    <span className="text-meta text-text-muted">Added {new Date(install.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-body text-text-muted">This bot isn't installed in any guilds yet.</p>
            )}
          </>
        )}

        {/* Commands tab */}
        {tab === 'commands' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-section uppercase text-text-secondary">Global commands</p>
              <Button size="sm" variant={showCommandBuilder ? 'secondary' : 'default'} onClick={onToggleCommandBuilder}>
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
              <p className="text-body text-text-muted">No global commands registered yet.</p>
            ) : (
              <div className="space-y-2">
                {commands.map((cmd) => (
                  <div
                    key={cmd.id}
                    className="group/cmd flex items-center gap-3 rounded-sm border border-border-subtle bg-bg-secondary px-3 py-2"
                  >
                    <code className="font-code text-meta font-semibold text-text-primary">/{cmd.name}</code>
                    <span className="flex-1 truncate text-body text-text-muted">{cmd.description}</span>
                    <button
                      type="button"
                      className="rounded-sm px-2 py-1 text-label font-semibold text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                      onClick={() => onEditCommand(cmd)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary outline-none transition-colors hover:bg-danger-tint hover:text-accent-danger focus-visible:shadow-[var(--focus-ring)]"
                      onClick={() => onDeleteCommand(cmd.id)}
                      aria-label={`Delete command ${cmd.name}`}
                      title={`Delete command ${cmd.name}`}
                    >
                      <Trash2 size={14} />
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
            <p className="text-section uppercase text-text-secondary">Gateway intents</p>
            <IntentSelector value={intents} onChange={onIntentsChange} />
            {dirty && (
              <Button size="sm" onClick={onSaveSettings} loading={saving} disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            )}
          </div>
        )}

        {/* Permissions tab */}
        {tab === 'permissions' && (
          <div className="space-y-3">
            <p className="text-section uppercase text-text-secondary">Default bot permissions</p>
            <PermissionCalculator value={permissions} onChange={onPermissionsChange} />
            {dirty && (
              <Button size="sm" onClick={onSaveSettings} loading={saving} disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
