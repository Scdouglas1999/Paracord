import * as React from "react"
import { cn } from "../../lib/utils"

// Recipe: design-spec §7 (Input / select / textarea). 40px, inset fill darker than
// surround (--bg-tertiary), 1px --border-subtle, radius-sm. Focus = --accent-primary
// border + --focus-ring-input (no outer glow).
const fieldBase =
    "w-full rounded-sm border border-border-subtle bg-bg-tertiary text-body text-text-primary placeholder:text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)] disabled:cursor-not-allowed disabled:opacity-50"

const fieldError =
    "border-accent-danger focus-visible:border-accent-danger focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent-danger)_25%,transparent)]"

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
                    "h-10 px-3 file:border-0 file:bg-transparent file:text-sm file:font-medium",
                    error ? fieldError : "hover:border-border-strong",
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
                    error ? fieldError : "hover:border-border-strong",
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

// appearance-none + a tokenized inline chevron (currentColor, muted) — never the
// browser default arrow.
const CHEVRON =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%237A8B82' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")"

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
    ({ className, error, children, ...props }, ref) => {
        return (
            <select
                className={cn(
                    fieldBase,
                    "h-10 cursor-pointer appearance-none bg-[position:right_0.65rem_center] bg-no-repeat pl-3 pr-9",
                    error ? fieldError : "hover:border-border-strong",
                    className
                )}
                style={{ backgroundImage: CHEVRON }}
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
