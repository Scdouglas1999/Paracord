import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, X, type LucideIcon } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';

/**
 * The header's action cluster (docs/lantern-stage-spec.md §7.4).
 *
 * Search, pins, threads and one labeled overflow — the controls a room's header
 * carries. Counts ride on the control they belong to, in the mono meta face.
 *
 * Two rules this file keeps:
 *   - Nothing here spends a light token. A count of pinned messages is not
 *     somebody being present (§0, §6.3), so these are quiet ghost controls and
 *     the action color marks only what is currently open.
 *   - The narrow layout is `docs/layout-spec.md` §7.8: below the small
 *     breakpoint only the high-frequency controls stay visible and the rest
 *     move into the overflow menu, which lists them at every width.
 */

export interface HeaderAction {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  reason?: string | null;
  controlsPanel?: boolean;
  /** A count that belongs to this control — "2 pinned", "3 threads". */
  count?: number | null;
  /** Hide below the small breakpoint; the overflow menu carries it there. */
  overflowWhenNarrow?: boolean;
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

/** 32px control, radius 9, quiet ink — §3 control heights, §9 hit targets. */
const HEADER_CONTROL =
  'pc-focusable relative inline-flex h-[var(--h-control)] min-w-[var(--h-control)] shrink-0 items-center '
  + 'justify-center gap-1.5 rounded-[var(--radius-control)] px-1.5 text-text-secondary '
  + 'transition-[background-color,color] duration-[var(--duration-fast)] ease-[var(--ease-out)] '
  + 'hover:bg-bg-mod-subtle hover:text-text-primary '
  + '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11';

function HeaderActionButton({
  label, icon: Icon, onClick, active, disabled, reason, controlsPanel, count, overflowWhenNarrow,
}: HeaderAction) {
  return <Tooltip content={reason ?? label} side="bottom">
    <button type="button" aria-label={label} aria-pressed={active}
      aria-expanded={controlsPanel ? Boolean(active) : undefined}
      title={reason ?? undefined} onClick={onClick} disabled={disabled}
      className={cn(
        HEADER_CONTROL,
        overflowWhenNarrow && 'hidden sm:inline-flex',
        active && 'bg-accent-tint text-accent-primary hover:bg-accent-tint-strong hover:text-accent-primary',
        disabled && 'cursor-not-allowed text-text-faint hover:bg-transparent hover:text-text-faint',
      )}>
      <Icon size={18} aria-hidden />
      {count != null && count > 0 && (
        <span className="pc-mono pr-0.5 text-meta text-text-faint">{count > 99 ? '99+' : count}</span>
      )}
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
    {activeSurface && SurfaceIcon && <button type="button"
      className={cn(
        'pc-focusable hidden min-w-0 max-w-[12rem] items-center gap-2 rounded-[var(--radius-control)]',
        'bg-bg-raised px-2.5 py-1.5 text-meta font-semibold text-text-primary',
        'shadow-[var(--shadow-raised)] transition-colors duration-[var(--duration-fast)]',
        'ease-[var(--ease-out)] hover:bg-bg-mod-strong sm:inline-flex',
      )}
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
          }} className={cn(
            HEADER_CONTROL,
            'px-2',
            position && 'bg-accent-tint text-accent-primary hover:bg-accent-tint-strong hover:text-accent-primary',
          )}>
          <span id={descriptionId} className="sr-only">{description}</span>
          <MoreHorizontal size={18} aria-hidden />
          <span className="chat-header-more-label">More</span>
          {mentions > 0 ? <span aria-hidden data-attention-kind="mentions" className="chat-header-mention-badge">@{mentions > 99 ? '99+' : mentions}</span>
            : unread > 0 ? <span aria-hidden data-attention-kind="unread" className="chat-header-unread-badge" /> : null}
        </button>
    </div>
    <ContextMenu label="Channel actions" anchorRef={trigger} open={position != null} position={position ?? undefined} items={menuItems} onClose={closeMenu} />
  </>;
}
