import type { LucideIcon } from 'lucide-react';
import { HomeSectionHeader } from './HomeSectionHeader';

export interface JumpInAction {
  icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
}

interface HomeJumpInRowProps {
  actions: JumpInAction[];
  /** Quieter label when the page already has live activity. */
  quiet?: boolean;
}

/**
 * Always-useful start-something strip for Home canvases. The label quiets down
 * when there is no live pulse, but the actions remain available in either state.
 * Horizontal action tiles — not a second sidebar, not stacked EmptyStates.
 */
export function HomeJumpInRow({ actions, quiet = true }: HomeJumpInRowProps) {
  return (
    <section aria-label="Jump in">
      <HomeSectionHeader
        label={quiet ? 'Start something' : 'Jump in'}
      />
      {/* Four across only from xl: at lg the sidebar leaves ~150px per tile,
          which clipped the labels themselves ("Explore spaces", "Create a
          space"). Two across below that keeps every tile readable. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className="group flex items-center gap-3 rounded-md border border-border-subtle bg-bg-secondary px-3 py-3 text-left shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-bg-mod-subtle text-text-secondary transition-colors group-hover:bg-accent-tint group-hover:text-accent-primary">
              <action.icon size={18} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-label font-semibold text-text-primary">
                {action.label}
              </span>
              {/* Wraps rather than truncates: at four across, the text column is
                  ~124px, which silently cut "Find public communities" down to
                  "Find public commu…". Grid items stretch, so the tiles in a row
                  stay the same height when one hint takes two lines. */}
              <span className="mt-0.5 block text-meta text-text-muted line-clamp-2">
                {action.hint}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
