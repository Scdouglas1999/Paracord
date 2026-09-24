import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { SettingsSectionHeader, type SettingsSectionHeaderProps } from '../ui';

// Shared settings-surface language for the guild-settings module
// (docs/lantern-stage-spec.md §2, §4, §6.8).
//
// Space settings are ONE plate over the street (SettingsShell). Everything in
// here therefore lives *inside* that plate: a section leads with a Gabarito
// title + a one-line explanation, then divider-separated rows, wells and raised
// rows. Never a second plate, never a bordered tint box.

export type { SettingsSectionHeaderProps };

/**
 * The head of a settings section. Delegates to the shared
 * {@link SettingsSectionHeader} recipe (Gabarito Title step + one specific line
 * of body copy + at most one primary action); the bottom margin is dropped
 * because every section here sits in a `gap`-spaced stack.
 */
export function SectionHeader({ className, ...props }: SettingsSectionHeaderProps) {
  return <SettingsSectionHeader {...props} className={cn('mb-0', className)} />;
}

/**
 * The quiet signpost that opens a grouped block of rows (§2 Section step).
 * **Sentence case, never uppercase, no tracking** (§6.8).
 */
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('text-section text-text-faint', className)}>{children}</div>;
}

/**
 * The label above a form control. Same Section step as {@link GroupLabel} —
 * sentence case, quiet, and never shouting over the value it names.
 */
export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('mb-2 block text-section text-text-faint', className)}>{children}</span>
  );
}

/**
 * A read-only, permission-gated notice: a **well** inside the settings plate
 * (§1.1 — recessed, inset shadow), never a bordered tint box. The text wraps:
 * it explains what the reader cannot do and what to do about it, so it must
 * never be truncated (§10).
 */
export function GateNotice({ children }: { children: ReactNode }) {
  return (
    <div className="pc-well px-4 py-3 text-body leading-relaxed text-text-secondary">{children}</div>
  );
}

// The boolean control and the labeled boolean row are the app-wide primitives
// (ui/Switch.tsx). They used to be duplicated here with a literal `bg-white`
// knob; re-exported so every settings call site paints the one recipe.
export { Switch, ToggleRow } from '../ui';
export type { SwitchProps, ToggleRowProps } from '../ui';
