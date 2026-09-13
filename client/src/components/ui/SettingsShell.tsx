import * as React from 'react';
import { ArrowLeft, ChevronRight, X } from 'lucide-react';
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
  /** Sentence case (§6.8). Omit for the first, unlabelled group. */
  label?: string;
  items: SettingsNavItem[];
}

export interface SettingsShellProps {
  /** Accessible name of the index — "User settings", "Space settings". */
  label: string;
  /** What is being configured: the person's name, the space's name. */
  title: string;
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
 * SettingsShell — settings open as **one plate over the street** (spec §4):
 * a left index of sections in sentence case, and the selected section's content
 * beside it in wells and raised rows. There is no second plate inside; the
 * index and the content share this one, parted by a hairline (§1.6).
 *
 * Presentation only: the caller owns which section is active, what the content
 * is, and — on phones, where the index and the content are two screens — the
 * history behaviour that moves between them.
 */
export function SettingsShell({
  label,
  title,
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
  const allItems = groups.flatMap((group) => group.items);
  const activeLabel = allItems.find((item) => item.id === active)?.label ?? active;

  if (isMobile) {
    return (
      <div
        className={cn('pc-plate flex h-full min-h-0 flex-col overflow-hidden p-0', className)}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        {showIndex ? (
          <>
            <header className="flex items-center justify-between gap-3 px-4 pb-3 pt-[calc(var(--safe-top)+0.75rem)]">
              <h1 className="pc-display min-w-0 truncate text-title text-text-primary">{title}</h1>
              <IconButton label={closeLabel} size="lg" tone="raised" onClick={onClose}>
                <X size={18} />
              </IconButton>
            </header>
            <nav
              aria-label={label}
              className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-[calc(var(--safe-bottom)+1rem)]"
            >
              {groups.map((group, index) => (
                <div key={group.label ?? `group-${index}`} className="flex flex-col gap-0.5">
                  {group.label && <SectionLabel className="pt-1">{group.label}</SectionLabel>}
                  {group.items.map((item) => (
                    <NavRow
                      key={item.id}
                      icon={item.icon}
                      className="h-[var(--h-control-phone)]"
                      trailing={
                        <>
                          {item.meta}
                          <ChevronRight size={16} className="text-text-faint" aria-hidden />
                        </>
                      }
                      onClick={() => onSelect(item.id)}
                    >
                      {item.label}
                    </NavRow>
                  ))}
                </div>
              ))}
              {indexFooter && (
                <div className="flex flex-col gap-0.5">
                  <Divider className="my-1" />
                  {indexFooter}
                </div>
              )}
            </nav>
          </>
        ) : (
          <>
            <header className="flex shrink-0 items-center gap-2 px-3 pb-2.5 pt-[calc(var(--safe-top)+0.75rem)]">
              <IconButton
                label="Back to the settings index"
                size="lg"
                tone="raised"
                onClick={() => onShowIndex?.(true)}
              >
                <ArrowLeft size={18} />
              </IconButton>
              <h1 className="pc-display min-w-0 flex-1 truncate text-heading text-text-primary">
                {activeLabel}
              </h1>
              <IconButton label={closeLabel} size="lg" tone="raised" onClick={onClose}>
                <X size={18} />
              </IconButton>
            </header>
            <Divider />
            <div
              className={cn(
                'min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(var(--safe-bottom)+1.5rem)] pt-5',
                contentClassName,
              )}
            >
              {children}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn('pc-plate flex h-full min-h-0 overflow-hidden p-0', className)}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <nav
        aria-label={label}
        className="flex w-[clamp(13rem,22vw,17rem)] shrink-0 flex-col overflow-y-auto px-3 py-5"
      >
        <SectionLabel className="pt-0">{title}</SectionLabel>
        <div className="flex flex-col gap-4">
          {groups.map((group, index) => (
            <div key={group.label ?? `group-${index}`} className="flex flex-col gap-0.5">
              {group.label && <SectionLabel className="pt-1">{group.label}</SectionLabel>}
              {group.items.map((item) => (
                <NavRow
                  key={item.id}
                  icon={item.icon}
                  trailing={item.meta}
                  active={item.id === active}
                  onClick={() => onSelect(item.id)}
                >
                  {item.label}
                </NavRow>
              ))}
            </div>
          ))}
        </div>
        {indexFooter && (
          <div className="mt-auto flex flex-col gap-0.5 pt-5">
            <Divider className="mb-2" />
            {indexFooter}
          </div>
        )}
      </nav>

      <Divider orientation="vertical" />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="absolute right-5 top-5 z-10 flex flex-col items-center gap-1">
          <IconButton label={closeLabel} tone="raised" onClick={onClose}>
            <X size={18} />
          </IconButton>
          <Kbd>Esc</Kbd>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-8 lg:px-10 lg:py-9', contentClassName)}>
          <div className="mx-auto w-full max-w-[46rem] pr-14">{children}</div>
        </div>
      </div>
    </div>
  );
}

export interface SettingsSectionHeaderProps {
  title: string;
  description?: React.ReactNode;
  /** The one primary action for this screen (§7: one primary action per screen). */
  action?: React.ReactNode;
  className?: string;
}

/**
 * The head of a settings section: a Gabarito heading, one line of specific
 * explanation, and at most one primary action.
 */
export function SettingsSectionHeader({
  title,
  description,
  action,
  className,
}: SettingsSectionHeaderProps) {
  return (
    <header className={cn('mb-6 flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="pc-display text-title text-text-primary">{title}</h2>
        {description && (
          <p className="mt-1.5 max-w-prose text-body text-text-secondary">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
