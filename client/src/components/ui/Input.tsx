import * as React from "react"
import { cn } from "../../lib/utils"

/**
 * The three bare form controls (docs/index-spec.md §6.14).
 *
 * A field you type into is the field fill with a hairline (`pc-field`): 44 tall
 * at radius 12, a 15px value and a placeholder in the tertiary ink. Focus
 * brightens the edge and draws the one focus ring; an invalid field carries the
 * danger ink as its edge.
 *
 * {@link TextField} composes an Input with its label, hint and error wiring —
 * prefer it. These are for the cases that already own their labeling.
 */
const fieldBase = [
    "pc-field w-full text-[15px] text-[var(--ix-ink)] placeholder:text-[var(--ix-ink-3)]",
    "disabled:cursor-not-allowed disabled:opacity-60",
].join(" ")

const fieldError = "shadow-[inset_0_0_0_1px_var(--ix-danger-ink)]"

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
                    "h-[var(--h-control-phone)] px-3 file:border-0 file:bg-transparent file:text-[14px] file:font-medium file:text-[var(--ix-ink-2)]",
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
 * `--select-chevron`, a data URI in the tertiary ink (tokens.css).
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
