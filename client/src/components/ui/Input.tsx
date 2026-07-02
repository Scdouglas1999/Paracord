import * as React from "react"
import { cn } from "../../lib/utils"

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
                    "flex h-11 w-full rounded-xl border border-border-subtle bg-black/20 shadow-inner px-3.5 py-2.5 text-sm ring-offset-bg-primary file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-text-muted focus-visible:outline-none focus-visible:border-accent-primary focus-visible:ring-4 focus-visible:ring-accent-primary/20 focus-visible:bg-black/40 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200",
                    error ? "border-accent-danger focus-visible:border-accent-danger focus-visible:ring-accent-danger/20" : "hover:border-border-strong",
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export { Input }
