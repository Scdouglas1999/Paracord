import * as React from "react"
import { cn } from "../../lib/utils"

/**
 * The three bare form controls, on the Lantern Stage well recipe
 * (docs/lantern-stage-spec.md §1.1, §3, §9).
 *
 * A field you type into is a **well**: recessed inside its plate, depth from
 * the inset shadow, never a border-only edge. Focus is the §9 ring layered over
 * that shadow; an invalid field carries a 1px danger edge in the same slot.
 *
 * {@link TextField} composes an Input with its label, hint and error wiring —
 * prefer it. These are for the cases that already own their labelling.
 */
const fieldBase = [
    "pc-well w-full text-label text-text-primary placeholder:text-text-faint",
    "outline-none",
    "focus-visible:shadow-[var(--shadow-well),var(--focus-ring)]",
    "disabled:cursor-not-allowed disabled:opacity-60",
].join(" ")

const fieldError =
    "shadow-[var(--shadow-well),0_0_0_1px_var(--accent-danger)] focus-visible:shadow-[var(--shadow-well),0_0_0_1px_var(--accent-danger),var(--focus-ring)]"

export interface InputProps
    extends React.InputHTMLAttributes<HTMLInputElement> {
    error?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    ({ className, type, error, ...props }, ref) => {
        return (
            <input
                type={type}
                className={cn(
                    fieldBase,
                    "h-[var(--h-control-phone)] px-3 file:border-0 file:bg-transparent file:text-label file:font-medium file:text-text-secondary",
                    error && fieldError,
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export interface TextareaProps
    extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    error?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ className, error, ...props }, ref) => {
        return (
            <textarea
                className={cn(
                    fieldBase,
                    "min-h-[80px] px-3 py-2.5 leading-relaxed",
                    error && fieldError,
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Textarea.displayName = "Textarea"

export interface SelectProps
    extends React.SelectHTMLAttributes<HTMLSelectElement> {
    error?: boolean;
}

/**
 * Select — the browser's own arrow is suppressed; the chevron comes from
 * `--select-chevron`, which each theme defines in its own muted ink.
 */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
    ({ className, error, children, ...props }, ref) => {
        return (
            <select
                className={cn(
                    fieldBase,
                    "pc-select h-[var(--h-control-phone)] cursor-pointer appearance-none pl-3 pr-9",
                    error && fieldError,
                    className
                )}
                ref={ref}
                {...props}
            >
                {children}
            </select>
        )
    }
)
Select.displayName = "Select"

export { Input, Textarea, Select }
