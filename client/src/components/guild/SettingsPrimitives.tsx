import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

// Shared settings-surface language for the guild-settings module (design-spec §7).
// Each section leads with a Fraunces Heading step + a --text-secondary description,
// then divider-separated rows — never tiled identical cards (kill-list #5).

interface SectionHeaderProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function SectionHeader({ title, description, action, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="font-display text-heading text-text-primary">{title}</h2>
        {description && (
          <p className="mt-1.5 max-w-prose text-[13.5px] leading-relaxed text-text-secondary">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// UPPERCASE category label (Section step) that opens a grouped block of rows.
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-section uppercase text-text-muted', className)}>{children}</div>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

// Switch control (design brief): track --bg-mod-strong → --accent-primary, knob
// radius-full, visible focus-visible ring. role="switch" for assistive tech.
export function Switch({ checked, onChange, disabled, id, 'aria-label': ariaLabel }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent-primary' : 'bg-bg-mod-strong',
      )}
    >
      <span
        className={cn(
          'inline-block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-[140ms] ease-[var(--ease-out)]',
          checked ? 'translate-x-[20px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

interface ToggleRowProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

// A labelled boolean row: text on the left, Switch on the right, hairline divider
// above (applied by the parent stack). Comfortable but not marketing-sparse (#10).
export function ToggleRow({ label, description, checked, onChange, disabled, ariaLabel }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-label text-text-primary">{label}</div>
        {description && <div className="mt-0.5 text-meta text-text-secondary">{description}</div>}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      />
    </div>
  );
}

// Field label (Label step) for a form control — small-caps, tracked, secondary.
export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('mb-2 block text-section uppercase text-text-secondary', className)}>
      {children}
    </span>
  );
}

// A read-only permission-gated notice — a tinted info callout, never a tiled card.
export function GateNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-mod-subtle px-4 py-3 text-[13.5px] leading-relaxed text-text-secondary">
      {children}
    </div>
  );
}
