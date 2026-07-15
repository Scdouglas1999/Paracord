import type { ReactNode } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Copy, Key, RefreshCw, Trash2, ShieldAlert, ExternalLink } from 'lucide-react';
import type { BotApplication } from '../../api/bots';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

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

const actionBtn =
  'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-label font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]';

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
    <div className="space-y-4 rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
          <Bot size={22} />
        </div>
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <div className="space-y-2">
              <Input value={editName} maxLength={80} onChange={(e) => onEditNameChange(e.target.value)} autoFocus />
              <Input value={editDescription} maxLength={400} placeholder="Description" onChange={(e) => onEditDescriptionChange(e.target.value)} />
            </div>
          ) : (
            <>
              <p className="text-label font-semibold text-text-primary">{app.name}</p>
              {app.description && <p className="mt-0.5 text-body text-text-secondary">{app.description}</p>}
            </>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-code text-meta text-text-muted">
            <span>ID {app.id}</span>
            <span aria-hidden className="text-border-strong">·</span>
            <span>Bot {app.bot_user_id}</span>
            <span aria-hidden className="text-border-strong">·</span>
            <span>Created {new Date(app.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      </div>

      {/* Token area — secret, mono, reveal/copy + a security warning. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-section uppercase text-text-secondary">Bot token</span>
          {token && (
            <span className="inline-flex items-center gap-1 text-meta font-medium text-accent-warning">
              <ShieldAlert size={13} />
              Treat like a password
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2">
          {token ? (
            <>
              <code className="flex-1 break-all font-code text-meta text-text-secondary">{token}</code>
              <button type="button" aria-label="Copy bot token" className={actionBtn} onClick={onCopyToken}>
                {copied ? (<><Check size={13} /> Copied</>) : (<><Copy size={13} /> Copy</>)}
              </button>
            </>
          ) : (
            <span className="font-code text-meta text-text-muted">
              Token hidden — regenerate to reveal a new one.
            </span>
          )}
        </div>
      </div>

      {/* Install / OAuth link */}
      <div className="space-y-2">
        <span className="text-section uppercase text-text-secondary">Install link</span>
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2">
          <code className="flex-1 break-all font-code text-meta text-text-secondary">{installUrl}</code>
          <button type="button" aria-label="Copy install link" className={actionBtn} onClick={onCopyInstallUrl}>
            {copiedInvite ? (<><Check size={13} /> Copied</>) : (<><Copy size={13} /> Copy Link</>)}
          </button>
          <a href={installUrl} target="_blank" rel="noreferrer" className={actionBtn}>
            <ExternalLink size={13} /> Open
          </a>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1 border-t border-border-subtle pt-3">
        {isEditing ? (
          <>
            <Button size="sm" onClick={onSaveEdit}>Save</Button>
            <button type="button" className={actionBtn} onClick={onCancelEdit}>Cancel</button>
          </>
        ) : (
          <button type="button" className={actionBtn} onClick={onStartEditing}>Edit</button>
        )}
        <button type="button" className={actionBtn} onClick={onRegenerateToken}>
          <Key size={14} />
          Regen Token
        </button>
        <button
          type="button"
          className={cn(actionBtn, isExpanded && 'bg-bg-mod-subtle text-text-primary')}
          onClick={onToggleAdvanced}
          aria-expanded={isExpanded}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Advanced
        </button>
        <button type="button" className={actionBtn} onClick={onReload}>
          <RefreshCw size={14} />
          Reload
        </button>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-label font-semibold text-accent-danger outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-danger-tint focus-visible:shadow-[var(--focus-ring)]"
          onClick={onDelete}
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>

      {/* Advanced expansion with tabs */}
      {isExpanded && advanced}

      {metrics}
    </div>
  );
}
