import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type'> {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Required unless the switch is wired to a visible label. */
  label?: string;
  /** id of the element that names this switch (a ToggleRow's label). */
  labeledBy?: string;
  size?: 'sm' | 'md';
}

/**
 * Switch: the one boolean control in the app (docs/index-spec.md §1.4, §3.1).
 *
 * Off is a quiet capsule (the control fill, a muted knob). On is cream with a dark
 * knob: cream is the one action, the way the send circle turns cream (§5.13).
 * Amber stays with what is live, so the knob carries no glow. Hover is one step
 * lighter, press one step darker, over 40ms; nothing scales.
 *
 * `role="switch"` + `aria-checked` give assistive tech the state; the knob is
 * only the visual half of it.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, labeledBy, size = 'md', className, disabled, ...props },
  ref,
) {
  const track = size === 'sm' ? 'h-[22px] w-10' : 'h-6 w-11';
  const knob = size === 'sm' ? 'h-[16px] w-[16px]' : 'h-[18px] w-[18px]';
  const travel =
    size === 'sm'
      ? checked
        ? 'translate-x-[21px]'
        : 'translate-x-[3px]'
      : checked
        ? 'translate-x-[23px]'
        : 'translate-x-[3px]';

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labeledBy ? undefined : label}
      aria-labelledby={labeledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'pc-focusable relative inline-flex shrink-0 items-center rounded-[var(--radius-full)]',
        'transition-colors duration-[40ms] ease-[var(--ix-ease)]',
        'disabled:cursor-not-allowed disabled:opacity-[.45]',
        track,
        checked
          ? 'bg-accent-primary hover:bg-accent-primary-hover active:bg-accent-primary-active'
          : 'bg-[var(--ix-fill-ctl-hover)] hover:bg-[var(--ix-fill-2)] active:bg-[var(--ix-fill)]',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'relative inline-block rounded-[var(--radius-full)]',
          // The thumb slides on the ease-out over --duration-normal, never a jump.
          'transition-transform duration-[var(--duration-normal)] ease-[var(--ease-out)]',
          knob,
          checked ? 'bg-text-on-accent' : 'bg-[var(--ix-ink-2)]',
          travel,
        )}
      />
    </button>
  );
});

export interface ToggleRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Fallback accessible name when `label` is not a plain string. */
  ariaLabel?: string;
  /** Extra content under the description — a nested field the toggle governs. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * ToggleRow — a labeled boolean: text on the left, {@link Switch} on the
 * right. The whole row's text names the switch, so the name a screen reader
 * announces is the sentence a sighted reader sees.
 */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  ariaLabel,
  children,
  className,
}: ToggleRowProps) {
  const labelId = React.useId();
  return (
    <div className={cn('flex items-start justify-between gap-4 py-3', className)}>
      <div className="min-w-0">
        <div id={labelId} className="text-[15px] font-medium text-[var(--ix-ink)]">
          {label}
        </div>
        {description && (
          <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ix-ink-3)]">{description}</p>
        )}
        {children}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        labeledBy={ariaLabel ? undefined : labelId}
        label={ariaLabel}
      />
    </div>
  );
}
