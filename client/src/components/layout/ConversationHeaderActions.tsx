import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, X, type LucideIcon } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';

export interface HeaderAction {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  reason?: string | null;
  controlsPanel?: boolean;
}
export interface ActiveHeaderSurface {
  label: string;
  icon: LucideIcon;
  onClose: () => void;
}

export function attentionDescription(unread: number, mentions: number): string {
  const conversations = `${unread} unread conversation${unread === 1 ? '' : 's'}`;
  return mentions > 0 ? `${mentions} mention${mentions === 1 ? '' : 's'} in ${conversations}`
    : unread > 0 ? conversations : 'No unread conversations';
}

function HeaderActionButton({ label, icon: Icon, onClick, active, disabled, reason, controlsPanel }: HeaderAction) {
  return <Tooltip content={reason ?? label} side="bottom">
    <button type="button" aria-label={label} aria-pressed={active}
      aria-expanded={controlsPanel ? Boolean(active) : undefined}
      title={reason ?? undefined} onClick={onClick} disabled={disabled}
      className={cn('chat-header-action', active && 'bg-accent-tint text-accent-primary', disabled && 'cursor-not-allowed text-text-muted')}>
      <Icon size={18} aria-hidden />
    </button>
  </Tooltip>;
}

/** Stable action components preserve keyboard focus when unread/voice data ticks. */
export function ConversationHeaderActions({ primary, items, activeSurface, unread, mentions, indicator }: {
  primary: HeaderAction[];
  items: ContextMenuItem[];
  activeSurface?: ActiveHeaderSurface;
  unread: number;
  mentions: number;
  indicator?: React.ReactNode;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(true);
  const surfaceKey = activeSurface?.label ?? primary.find(action => action.active && action.controlsPanel)?.label ?? '';
  useEffect(() => { setPosition(null); }, [surfaceKey]);
  const descriptionId = useId();
  const description = attentionDescription(unread, mentions);
  const closeMenu = () => {
    setPosition(null);
    if (restoreFocus.current) trigger.current?.focus({ preventScroll: true });
  };
  const openMenu = () => {
    if (position) { closeMenu(); return; }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    restoreFocus.current = true;
    setPosition({ x: rect.right - 280, y: rect.bottom + 6 });
  };
  const menuItems = items.map(item => ({ ...item, action: () => {
    // The destination panel/dialog owns focus after selection. Restoring it to
    // the launcher here would steal focus from that newly opened surface.
    restoreFocus.current = false;
    trigger.current?.focus({ preventScroll: true });
    item.action();
  } }));
  const SurfaceIcon = activeSurface?.icon;
  return <>
    {activeSurface && SurfaceIcon && <button type="button" className="chat-header-active"
      aria-label={`Close ${activeSurface.label}`} aria-expanded="true"
      onClick={() => { activeSurface.onClose(); trigger.current?.focus({ preventScroll: true }); }}>
      <SurfaceIcon size={16} aria-hidden />
      <span className="min-w-0 truncate">{activeSurface.label}</span>
      <X size={14} aria-hidden className="ml-auto shrink-0" />
    </button>}
    <div className="chat-header-actions" aria-label="Conversation actions">
      {indicator}
      {primary.map(item => <HeaderActionButton key={item.label} {...item} />)}
        <button type="button" ref={trigger} aria-label="More channel actions"
          aria-describedby={descriptionId} aria-haspopup="menu" aria-expanded={Boolean(position)}
          onClick={openMenu} onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); if (!position) openMenu(); }
          }} className={cn('chat-header-action chat-header-more', position && 'bg-accent-tint text-accent-primary')}>
          <span id={descriptionId} className="sr-only">{description}</span>
          <MoreHorizontal size={18} aria-hidden />
          <span className="chat-header-more-label">More</span>
          {mentions > 0 ? <span aria-hidden data-attention-kind="mentions" className="chat-header-mention-badge">@{mentions > 99 ? '99+' : mentions}</span>
            : unread > 0 ? <span aria-hidden data-attention-kind="unread" className="chat-header-unread-badge" /> : null}
        </button>
    </div>
    {position && <ContextMenu label="Channel actions" anchorRef={trigger} position={position} items={menuItems} onClose={closeMenu} />}
  </>;
}
