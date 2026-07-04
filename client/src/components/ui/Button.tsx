import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { motion, useReducedMotion, HTMLMotionProps } from "framer-motion";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

// Recipes: design-spec §7 (Button). Controls are radius-sm (8px), 36px tall,
// press = scale(.97) only, hover is a bg/color change, focus-visible renders the
// layered --focus-ring. No gradient fills, no drop-glow, no hover lift.
const buttonVariants = cva(
    "relative inline-flex select-none items-center justify-center whitespace-nowrap rounded-sm text-sm font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-60",
    {
        variants: {
            variant: {
                // Primary — solid emerald, near-black ink, resting elevation.
                default:
                    "bg-accent-primary text-text-on-accent shadow-sm hover:bg-accent-primary-hover active:bg-accent-primary-active",
                // Danger — deepened fill + white text (AA), darken on hover.
                destructive:
                    "bg-accent-danger-fill text-text-on-danger shadow-sm hover:bg-[color-mix(in_srgb,var(--accent-danger-fill)_90%,#000)] active:bg-[color-mix(in_srgb,var(--accent-danger-fill)_82%,#000)]",
                // Secondary — quiet raised neutral for paired actions.
                secondary:
                    "border border-border-subtle bg-bg-mod-subtle text-text-primary shadow-sm hover:bg-bg-mod-strong",
                // Outline — hairline edge, transparent fill.
                outline:
                    "border border-border-subtle bg-transparent text-text-primary hover:bg-bg-mod-subtle",
                // Ghost — text-only, wash on hover.
                ghost:
                    "bg-transparent text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary",
                link:
                    "px-1 py-0 text-text-link underline-offset-4 hover:underline",
            },
            size: {
                default: "h-9 px-3.5",
                sm: "h-8 px-3 text-[13px]",
                lg: "h-11 px-5 text-[15px]",
                icon: "h-9 w-9 p-0",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
);

export interface ButtonProps
    extends Omit<HTMLMotionProps<"button">, "ref">,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean;
    loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, loading, children, disabled, type = "button", ...props }, ref) => {
        const reduceMotion = useReducedMotion();
        return (
            <motion.button
                ref={ref}
                type={type}
                whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                className={cn(buttonVariants({ variant, size, className }))}
                disabled={disabled || loading}
                {...props}
            >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {children as React.ReactNode}
            </motion.button>
        );
    }
);
Button.displayName = "Button";

export { Button, buttonVariants };
