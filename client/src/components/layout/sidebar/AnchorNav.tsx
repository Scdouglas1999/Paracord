import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Users, MessageCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';

/**
 * Fixed anchor navigation (layout-spec Option-1 top group). Three compact, always-
 * present rows — Home, Friends, Messages — pinned ABOVE the attention-ranked sections
 * so the zero-state / low-activity destinations (the full DM list, the friends surface,
 * incoming requests) are always reachable from anywhere in the app.
 *
 * NOT attention-ranked: no section header, a hairline divider below, and deliberately
 * quieter than the ranked rows (design-spec §7 Nav item recipe — tokens only). Active =
 * `--accent-tint` fill + a 3px teal (`--accent-secondary`) left edge bar + emerald icon,
 * driven by the current route. Friends carries an emerald count badge for incoming
 * friend requests. Each row joins the sidebar roving-tabindex order as one of the first
 * items via `data-nav-index` + a single roving Tab stop (`activeNavIndex`).
 */

interface AnchorItem {
  key: string;
  label: string;
  Icon: LucideIcon;
  to: string;
  active: boolean;
  /** Emerald count badge (Friends → incoming requests); rendered only when > 0. */
  badge: number;
}

export interface AnchorNavProps {
  /** Incoming friend-request count → emerald badge on the Friends row. */
  friendRequestCount: number;
  /** Flat roving-tabindex ordinal of the first anchor row (Home). */
  navIndexStart?: number;
  /** Flat ordinal of the single roving Tab stop; -1 on every other row. */
  activeNavIndex?: number;
}

export function AnchorNav({ friendRequestCount, navIndexStart = 0, activeNavIndex }: AnchorNavProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const items: AnchorItem[] = [
    { key: 'home', label: 'Home', Icon: Home, to: '/app', active: pathname === '/app' || pathname === '/app/', badge: 0 },
    { key: 'friends', label: 'Friends', Icon: Users, to: '/app/friends', active: pathname.startsWith('/app/friends'), badge: friendRequestCount },
    { key: 'messages', label: 'Messages', Icon: MessageCircle, to: '/app/dms', active: pathname.startsWith('/app/dms'), badge: 0 },
  ];

  return (
    <div>
      <div role="group" aria-label="Primary" className="flex flex-col gap-0.5">
        {items.map((item, i) => {
          const navIndex = navIndexStart + i;
          const showBadge = item.badge > 0;
          return (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={item.active}
              aria-current={item.active ? 'page' : undefined}
              data-nav-index={navIndex}
              tabIndex={navIndex === activeNavIndex ? 0 : -1}
              onClick={() => navigate(item.to)}
              className={cn(
                'group relative flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left outline-none',
                'transition-colors duration-[140ms] ease-[var(--ease-out)]',
                'focus-visible:shadow-[var(--focus-ring)]',
                item.active
                  ? 'bg-accent-tint text-text-primary'
                  : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
              )}
            >
              {item.active && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary"
                />
              )}
              <item.Icon
                size={18}
                aria-hidden
                className={cn('shrink-0', item.active ? 'text-accent-primary' : 'text-channel-icon')}
              />
              <span className="min-w-0 flex-1 truncate text-label">{item.label}</span>
              {showBadge && (
                <span
                  data-testid={`anchor-badge-${item.key}`}
                  aria-label={`${item.badge} pending friend ${item.badge === 1 ? 'request' : 'requests'}`}
                  className="flex h-4 min-w-4 items-center justify-center rounded-xs bg-accent-primary px-1 text-meta font-semibold tabular-nums text-text-on-accent"
                >
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* Hairline divider — separates the fixed anchors from the ranked sections. */}
      <div aria-hidden className="mt-2 h-px bg-border-subtle" />
    </div>
  );
}
