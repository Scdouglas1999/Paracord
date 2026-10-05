import * as React from 'react';
import { ArrowLeft, ChevronRight, X } from 'lucide-react';
import { useContentSwap } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { Divider } from './Divider';
import { IconButton } from './IconButton';
import { Kbd } from './Kbd';
import { NavRow } from './NavRow';
import { SectionLabel } from './SectionLabel';

export interface SettingsNavItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Trailing count or hint. */
  meta?: React.ReactNode;
}

export interface SettingsNavGroup {
  /** Sentence case (§6.8). Omit for the first, unlabeled group. */
  label?: string;
  items: SettingsNavItem[];
}

export interface SettingsShellProps {
  /** Accessible name of the index — "User settings", "Server settings". */
  label: string;
  /** What is being configured: the person's name, the server's name. */
  title: string;
  /** The line under the title ("User settings", "Server settings"). */
  subtitle?: string;
  /** The mark in the index's head: your `Avatar`, the server's `ServerMark` (40px). */
  lead?: React.ReactNode;
  /**
   * The window's hue, a number 0-359 (docs/index-spec.md §2.2): People's 210 for
   * user settings, the server's hue for server settings. It tints the index and
   * the selected row; nothing animates it.
   */
  hue?: number;
  groups: SettingsNavGroup[];
  active: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Accessible name of the close control. */
  closeLabel: string;
  /** Extra rows pinned under the index — a portal link, log out. */
  indexFooter?: React.ReactNode;
  /**
   * Phone layout: the index and the content are two screens. `true` shows the
   * index. Controlled so the caller keeps ownership of its history handling.
   */
  isMobile?: boolean;
  showIndex?: boolean;
  onShowIndex?: (next: boolean) => void;
  /** Content of the selected section. */
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * SettingsShell (docs/index-spec.md §6.7): settings are a full-window surface on
 * the ground. A 240px index on the left (a mark and the name, sentence-case group
 * labels, rows 34 tall at radius 10 with the hue selection) and the selected
 * section's column beside it (720 wide, a 28/700 title). Close and Esc sit at the
 * top right. The index and the content share the one surface, parted by a
 * hairline; there is no second pane inside.
 *
 * Presentation only: the caller owns which section is active, what the content
 * is, and — on phones, where the index and the content are two screens — the
 * history behavior that moves between them.
 */
export function SettingsShell({
  label,
  title,
  subtitle,
  lead,
  hue = 210,
  groups,
  active,
  onSelect,
  onClose,
  closeLabel,
  indexFooter,
  isMobile = false,
  showIndex = true,
  onShowIndex,
  children,
  className,
  contentClassName,
  onKeyDown,
}: SettingsShellProps) {
  // A section switch crossfades the new section in (§5.2); on a phone, moving
  // between the index and a section does the same for the whole screen.
  const sectionRef = useContentSwap<HTMLDivElement>(active);
  const phoneScreenRef = useContentSwap<HTMLDivElement>(showIndex ? '' : active);
  const allItems = groups.flatMap((group) => group.items);
  const activeLabel = allItems.find((item) => item.id === active)?.label ?? active;
  const hueStyle = { '--ix-hue': hue } as React.CSSProperties;

  const head = (
    <div className="ix-settings__head">
      {lead}
      <div className="ix-settings__who">
        <p className="ix-settings__name">{title}</p>
        {subtitle && <p className="ix-settings__line">{subtitle}</p>}
      </div>
    </div>
  );

  const index = (phone: boolean) => (
    <>
      {groups.map((group, index) => (
        <div key={group.label ?? `group-${index}`} className="ix-settings__group">
          {group.label && <SectionLabel>{group.label}</SectionLabel>}
          {group.items.map((item) => (
            <NavRow
              key={item.id}
              icon={item.icon}
              className={phone ? 'h-[var(--h-control-phone)]' : undefined}
              trailing={
                phone ? (
                  <>
                    {item.meta}
                    <ChevronRight size={16} className="text-[var(--ix-ink-3)]" aria-hidden />
                  </>
                ) : (
                  item.meta
                )
              }
              active={!phone && item.id === active}
              onClick={() => onSelect(item.id)}
            >
              {item.label}
            </NavRow>
          ))}
        </div>
      ))}
      {indexFooter && (
        <div className="ix-settings__foot">
          <Divider />
          {indexFooter}
        </div>
      )}
    </>
  );

  if (isMobile) {
    return (
      <div
        ref={phoneScreenRef}
        className={cn('ix-settings ix-settings--phone ix-lt', showIndex ? 'ix-hue-side' : 'ix-hue-main', className)}
        style={hueStyle}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        {showIndex ? (
          <>
            <header className="ix-settings__bar">
              {head}
              <IconButton label={closeLabel} size="lg" tone="raised" onClick={onClose}>
                <X size={18} />
              </IconButton>
            </header>
            <nav aria-label={label} className="ix-settings__phone-index">
              {index(true)}
            </nav>
          </>
        ) : (
          <>
            <header className="ix-settings__bar ix-settings__bar--section">
              <IconButton
                label="Back to the settings index"
                size="lg"
                tone="raised"
                onClick={() => onShowIndex?.(true)}
              >
                <ArrowLeft size={18} />
              </IconButton>
              {/* The section's own name is the first thing in the content
                  below, so this bar carries what is being configured instead —
                  context without saying the same word twice. */}
              <p className="ix-settings__line min-w-0 flex-1 truncate">{title}</p>
              <span className="sr-only">{activeLabel}</span>
              <IconButton label={closeLabel} size="lg" tone="raised" onClick={onClose}>
                <X size={18} />
              </IconButton>
            </header>
            <div className={cn('ix-settings__phone-body', contentClassName)}>{children}</div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={cn('ix-settings ix-lt', className)} style={hueStyle} onKeyDown={onKeyDown} tabIndex={-1}>
      <nav aria-label={label} className="ix-settings__nav ix-hue-side">
        {head}
        <div className="ix-settings__groups">{index(false)}</div>
      </nav>

      <div className="ix-settings__main ix-hue-main">
        <div className="ix-settings__close">
          <IconButton label={closeLabel} tone="raised" onClick={onClose}>
            <X size={18} />
          </IconButton>
          <Kbd>Esc</Kbd>
        </div>
        <div className={cn('ix-settings__scroll', contentClassName)}>
          <div ref={sectionRef} className="ix-settings__col">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface SettingsSectionHeaderProps {
  title: string;
  description?: React.ReactNode;
  /** The one primary action for this screen (§1.4: one cream button per surface). */
  action?: React.ReactNode;
  className?: string;
}

/**
 * The head of a settings section: a 28/700 title, one line of specific
 * explanation (14, tertiary ink), and at most one primary action.
 */
export function SettingsSectionHeader({
  title,
  description,
  action,
  className,
}: SettingsSectionHeaderProps) {
  return (
    <header className={cn('ix-settings__header', className)}>
      <div className="min-w-0">
        <h2 className="ix-settings__title">{title}</h2>
        {description && <p className="ix-settings__desc">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
