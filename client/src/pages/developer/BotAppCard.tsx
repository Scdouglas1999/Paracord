import type { ReactNode } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Copy, Key, RefreshCw, Trash2, ShieldAlert, ExternalLink } from 'lucide-react';
import type { BotApplication } from '../../api/bots';
import { getIdentityColor } from '../../lib/colors';
import { Button, Divider, TextField, Well } from '../../components/ui';

interface BotAppCardProps {
  app: BotApplication;
  isEditing: boolean;
  editName: string;
  editDescription: string;
  onEditNameChange: (value: string) => void;
  onEditDescriptionChange: (value: string) => void;
  token: string | undefined;
  copied: boolean;
  copiedInvite: boolean;
  installUrl: string;
  isExpanded: boolean;
  onStartEditing: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onRegenerateToken: () => void;
  onToggleAdvanced: () => void;
  onReload: () => void;
  onDelete: () => void;
  onCopyToken: () => void;
  onCopyInstallUrl: () => void;
  advanced: ReactNode;
  metrics: ReactNode;
}

/**
 * One application, as the content of the developer portal's plate — so it is
 * not a plate itself (spec §4). Secrets and links sit in wells; the actions are
 * a single row of ghost controls with the destructive one in the danger well.
 */
export function BotAppCard({
  app,
  isEditing,
  editName,
  editDescription,
  onEditNameChange,
  onEditDescriptionChange,
  token,
  copied,
  copiedInvite,
  installUrl,
  isExpanded,
  onStartEditing,
  onCancelEdit,
  onSaveEdit,
  onRegenerateToken,
  onToggleAdvanced,
  onReload,
  onDelete,
  onCopyToken,
  onCopyInstallUrl,
  advanced,
  metrics,
}: BotAppCardProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-well)] text-text-on-light"
          style={{ backgroundColor: getIdentityColor(app.id) }}
          aria-hidden
        >
          <Bot size={22} />
        </span>
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <div className="flex flex-col gap-2">
              <TextField
                label="Application name"
                hideLabel
                value={editName}
                maxLength={80}
                onChange={(e) => onEditNameChange(e.target.value)}
                autoFocus
              />
              <TextField
                label="Application description"
                hideLabel
                value={editDescription}
                maxLength={400}
                placeholder="Description"
                onChange={(e) => onEditDescriptionChange(e.target.value)}
              />
            </div>
          ) : (
            <>
              <h2 className="pc-display text-title text-text-primary">{app.name}</h2>
              {app.description && (
                <p className="mt-1 max-w-prose text-body text-text-secondary">{app.description}</p>
              )}
            </>
          )}
          <div className="pc-mono mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-muted">
            <span>ID {app.id}</span>
            <span aria-hidden className="text-text-faint">·</span>
            <span>Bot {app.bot_user_id}</span>
            <span aria-hidden className="text-text-faint">·</span>
            <span>Created {new Date(app.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      </div>

      {/* Token area — secret, mono, reveal/copy + a security warning. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-section text-text-faint">Bot token</span>
          {token && (
            <span className="inline-flex items-center gap-1 text-meta font-medium text-accent-warning">
              <ShieldAlert size={13} aria-hidden />
              Treat like a password
            </span>
          )}
        </div>
        <Well className="flex flex-wrap items-center gap-2 px-3 py-2">
          {token ? (
            <>
              <code className="pc-mono min-w-0 flex-1 break-all text-meta text-text-secondary">
                {token}
              </code>
              <Button variant="ghost" size="sm" aria-label="Copy bot token" onClick={onCopyToken}>
                {copied ? (<><Check size={13} /> Copied</>) : (<><Copy size={13} /> Copy</>)}
              </Button>
            </>
          ) : (
            <span className="pc-mono text-meta text-text-muted">
              Token hidden — regenerate to reveal a new one.
            </span>
          )}
        </Well>
      </div>

      {/* Install / OAuth link */}
      <div className="flex flex-col gap-2">
        <span className="text-section text-text-faint">Install link</span>
        <Well className="flex flex-wrap items-center gap-2 px-3 py-2">
          <code className="pc-mono min-w-0 flex-1 break-all text-meta text-text-secondary">
            {installUrl}
          </code>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Copy install link"
            onClick={onCopyInstallUrl}
          >
            {copiedInvite ? (<><Check size={13} /> Copied</>) : (<><Copy size={13} /> Copy Link</>)}
          </Button>
          <a
            href={installUrl}
            target="_blank"
            rel="noreferrer"
            className="pc-focusable inline-flex h-[var(--h-control-sm)] items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-meta font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary"
          >
            <ExternalLink size={13} aria-hidden /> Open
          </a>
        </Well>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3">
        <Divider />
        <div className="flex flex-wrap items-center gap-1">
          {isEditing ? (
            <>
              <Button size="sm" onClick={onSaveEdit}>Save</Button>
              <Button variant="ghost" size="sm" onClick={onCancelEdit}>Cancel</Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={onStartEditing}>Edit</Button>
          )}
          <Button variant="ghost" size="sm" onClick={onRegenerateToken}>
            <Key size={14} />
            Regen Token
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleAdvanced}
            aria-expanded={isExpanded}
            className={isExpanded ? 'bg-bg-mod-strong text-text-primary' : undefined}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Advanced
          </Button>
          <Button variant="ghost" size="sm" onClick={onReload}>
            <RefreshCw size={14} />
            Reload
          </Button>
          <Button variant="danger" size="sm" className="ml-auto" onClick={onDelete}>
            <Trash2 size={14} />
            Delete
          </Button>
        </div>
      </div>

      {/* Advanced expansion with tabs */}
      {isExpanded && advanced}

      {metrics}
    </div>
  );
}
