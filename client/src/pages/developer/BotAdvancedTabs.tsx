import { Plus, Server, Shield, Terminal, Trash2, Zap } from 'lucide-react';
import type { BotApplication, BotGuildInstall } from '../../api/bots';
import type { ApplicationCommand } from '../../types/commands';
import {
  Button,
  EmptyState,
  IconButton,
  LoadingSpinner,
  Tabs,
  type TabItem,
} from '../../components/ui';
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

// Sentence case, ids unchanged (§6.8).
const TABS: ReadonlyArray<TabItem<AdvancedTab>> = [
  { value: 'guilds', label: 'Guilds', icon: <Server size={14} /> },
  { value: 'commands', label: 'Commands', icon: <Terminal size={14} /> },
  { value: 'intents', label: 'Intents', icon: <Zap size={14} /> },
  { value: 'permissions', label: 'Permissions', icon: <Shield size={14} /> },
];

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
    <div>
      <Tabs
        items={TABS}
        value={tab}
        onChange={onTabChange}
        label="Application settings"
        variant="underline"
      />

      <div className="pt-4">
        {/* Guilds tab */}
        {tab === 'guilds' && (
          <>
            {installs && installs.length > 0 ? (
              <>
                <p className="text-section text-text-faint">Installed guilds</p>
                <ul className="mt-1 flex flex-col">
                  {installs.map((install) => (
                    <li
                      key={install.guild_id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle py-2.5"
                    >
                      <span className="pc-mono flex-1 text-meta text-text-primary">
                        Guild {install.guild_id}
                      </span>
                      <span className="pc-mono text-meta text-text-secondary">
                        Perms {install.permissions}
                      </span>
                      <span className="pc-mono text-meta text-text-muted">
                        Added {new Date(install.created_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <EmptyState
                icon={<Server size={20} />}
                title="Not installed anywhere yet"
                description="Share the install link above and every server that adds this bot will be listed here."
              />
            )}
          </>
        )}

        {/* Commands tab */}
        {tab === 'commands' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-section text-text-faint">Global commands</p>
              <Button
                size="sm"
                variant={showCommandBuilder ? 'ghost' : 'primary'}
                onClick={onToggleCommandBuilder}
              >
                {showCommandBuilder ? 'Cancel' : (<><Plus size={13} /> New command</>)}
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
              <EmptyState
                icon={<Terminal size={20} />}
                title="No commands registered yet"
                description="A global command is what people type after a slash in any server this bot is in. Create one to give it something to answer."
              />
            ) : (
              <ul className="flex flex-col">
                {commands.map((cmd) => (
                  <li
                    key={cmd.id}
                    className="flex items-center gap-3 border-t border-border-subtle py-2"
                  >
                    <code className="pc-mono text-meta font-semibold text-text-primary">
                      /{cmd.name}
                    </code>
                    <span className="flex-1 truncate text-label text-text-muted">
                      {cmd.description}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => onEditCommand(cmd)}>
                      Edit
                    </Button>
                    <IconButton
                      label={`Delete command ${cmd.name}`}
                      className="hover:bg-danger-well hover:text-accent-danger"
                      onClick={() => onDeleteCommand(cmd.id)}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Intents tab */}
        {tab === 'intents' && (
          <div className="flex flex-col gap-3">
            <IntentSelector value={intents} onChange={onIntentsChange} />
            {dirty && (
              <div>
                <Button size="sm" onClick={onSaveSettings} loading={saving} disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Permissions tab */}
        {tab === 'permissions' && (
          <div className="flex flex-col gap-3">
            <PermissionCalculator value={permissions} onChange={onPermissionsChange} />
            {dirty && (
              <div>
                <Button size="sm" onClick={onSaveSettings} loading={saving} disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
