import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { motion, useReducedMotion, HTMLMotionProps } from "framer-motion";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Button — docs/lantern-stage-spec.md §2 (Label step), §3 (control heights and
 * radii), §9 (focus ring, hit targets).
 *
 * Four real variants:
 *   primary  solid emerald, near-black ink — an action you can take.
 *   light    white-light fill, ink text — the ONE button that uses a light
 *            token, and only inside a lit context (Join a room where people are
 *            actually talking). It is state, not emphasis: never use it to make
 *            a button "pop" (§0, §6.3).
 *   ghost    text-only, wash on hover — the default for toolbar actions.
 *   danger   the danger *well* carrying danger ink — leave, hang up, destroy.
 *            Never a saturated red fill.
 *
 * Sizes are the spec's control heights: sm 28, md 32 (default), lg 44 (phone).
 * `icon` is a square 32 and `icon-lg` a square 44, both meeting the §9 hit
 * target floor on their platform.
 *
 * Legacy variant/size names (`default`, `destructive`, `secondary`, `outline`,
 * `link`) are kept as aliases so the un-restyled app keeps building; new code
 * uses the four above.
 */
const buttonVariants = cva(
    [
        "relative inline-flex select-none items-center justify-center gap-[7px] whitespace-nowrap",
        "rounded-[var(--radius-control)] text-label font-medium outline-none",
        "transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]",
        "focus-visible:shadow-[var(--focus-ring)]",
        "disabled:pointer-events-none disabled:opacity-60",
    ].join(" "),
    {
        variants: {
            variant: {
                primary:
                    "bg-accent-primary font-semibold text-text-on-accent hover:bg-accent-primary-hover active:bg-accent-primary-active",
                light:
                    "bg-light-white font-semibold text-text-on-light shadow-[var(--glow-light-fill)] hover:brightness-[1.04] active:brightness-[0.96]",
                ghost:
                    "bg-transparent text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary active:bg-bg-mod-strong",
                danger:
                    "bg-danger-well font-semibold text-accent-danger hover:brightness-125 active:brightness-95",
                // ---- legacy aliases (deprecated) ----
                default:
                    "bg-accent-primary font-semibold text-text-on-accent hover:bg-accent-primary-hover active:bg-accent-primary-active",
                destructive:
                    "bg-danger-well font-semibold text-accent-danger hover:brightness-125 active:brightness-95",
                secondary:
                    "bg-bg-raised text-text-primary shadow-[var(--shadow-chip)] hover:bg-bg-mod-strong",
                outline:
                    "border border-border-subtle bg-transparent text-text-primary hover:bg-bg-mod-subtle",
                link: "px-1 py-0 text-text-link underline-offset-4 hover:underline",
            },
            size: {
                sm: "h-[var(--h-control-sm)] px-2.5 text-meta",
                md: "h-[var(--h-control)] px-[11px]",
                lg: "h-[var(--h-control-phone)] px-4",
                icon: "h-[var(--h-control)] w-[var(--h-control)] p-0",
                "icon-lg": "h-[var(--h-control-phone)] w-[var(--h-control-phone)] p-0",
                // ---- legacy alias (deprecated): the old 36px default ----
                default: "h-[var(--h-control)] px-[11px]",
            },
        },
        defaultVariants: {
            variant: "primary",
            size: "md",
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
                transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
                className={cn(buttonVariants({ variant, size, className }))}
                disabled={disabled || loading}
                {...props}
            >
                {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {children as React.ReactNode}
            </motion.button>
        );
    }
);
Button.displayName = "Button";

export { Button, buttonVariants };
