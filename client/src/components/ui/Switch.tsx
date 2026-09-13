import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type'> {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Required unless the switch is wired to a visible label. */
  label?: string;
  /** id of the element that names this switch (a ToggleRow's label). */
  labelledBy?: string;
  size?: 'sm' | 'md';
}

/**
 * Switch — the one boolean control in the app (spec §1.1, §3, §9).
 *
 * Off is a **well**: recessed, matte, with the inset shadow every other
 * recessed control carries. On is the emerald — an action you have taken, not a
 * light (§6.3: a light token would assert that somebody is in a room).
 *
 * `role="switch"` + `aria-checked` give assistive tech the state; the knob is
 * only the visual half of it.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, labelledBy, size = 'md', className, disabled, ...props },
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
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'pc-focusable relative inline-flex shrink-0 items-center rounded-[var(--radius-full)]',
        'transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'disabled:cursor-not-allowed disabled:opacity-60',
        track,
        checked
          ? 'bg-accent-primary shadow-[var(--shadow-chip)]'
          : 'bg-bg-well shadow-[var(--shadow-well)]',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'relative inline-block rounded-[var(--radius-full)]',
          // §5.1: the thumb slides on the spring-settle over --duration-normal,
          // never a jump; its light (--thumb-glow) fades in over the warm-up
          // beat and only while the switch is on.
          'transition-transform duration-[var(--duration-normal)] ease-[var(--ease-spring-settle)]',
          'after:absolute after:inset-0 after:rounded-[var(--radius-full)] after:content-[""]',
          'after:bg-[var(--thumb-glow)] after:transition-opacity after:duration-[var(--duration-warm-up)] after:ease-[var(--ease-out)]',
          knob,
          checked ? 'bg-text-on-accent after:opacity-100' : 'bg-text-muted after:opacity-0',
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
 * ToggleRow — a labelled boolean: text on the left, {@link Switch} on the
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
        <div id={labelId} className="text-label text-text-primary">
          {label}
        </div>
        {description && (
          <p className="mt-0.5 text-meta leading-relaxed text-text-secondary">{description}</p>
        )}
        {children}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        labelledBy={ariaLabel ? undefined : labelId}
        label={ariaLabel}
      />
    </div>
  );
}
