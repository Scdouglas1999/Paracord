import type { ReactNode } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Copy, Key, RefreshCw, Trash2 } from 'lucide-react';
import type { BotApplication } from '../../api/bots';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/Button';

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
    <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 p-5 space-y-3">
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
                onChange={(e) => onEditNameChange(e.target.value)}
                autoFocus
              />
              <input
                className="input-field"
                value={editDescription}
                maxLength={400}
                placeholder="Description"
                onChange={(e) => onEditDescriptionChange(e.target.value)}
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
              onClick={onCopyToken}
            >
              {copied ? (
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
            onClick={onCopyInstallUrl}
          >
            {copiedInvite ? (
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
            <Button onClick={onSaveEdit}>
              Save
            </Button>
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
              onClick={onCancelEdit}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
            onClick={onStartEditing}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
          onClick={onRegenerateToken}
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
          onClick={onToggleAdvanced}
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Advanced
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary"
          onClick={onReload}
        >
          <RefreshCw size={13} />
          Reload
        </button>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-accent-danger hover:bg-accent-danger/12"
          onClick={onDelete}
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>

      {/* Advanced expansion with tabs */}
      {isExpanded && advanced}

      {metrics}
    </div>
  );
}
