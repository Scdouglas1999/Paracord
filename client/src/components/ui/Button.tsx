import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
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
        // pc-focusable: the §9 ring, faded in over --duration-fast (primitives).
        // Each visual variant carries pc-pressable — the §5.1 shared press:
        // 1px lift on hover, 0.96 for the 80ms press, a spring back on release
        // — and the accent ones layer pc-pressable-accent's one-beat flash.
        // `link` is underlined text, not a pressable surface, so it opts out.
        "pc-focusable",
        "relative inline-flex select-none items-center justify-center gap-[7px] whitespace-nowrap",
        "rounded-[var(--radius-control)] text-label font-medium outline-none",
        // No `transition-*` utility here: `.pc-pressable` already transitions
        // background, colour, shadow AND transform (the §5.1 spring). A utility
        // naming a shorter list would now win and drop the press.
        "disabled:pointer-events-none disabled:opacity-60",
    ].join(" "),
    {
        variants: {
            variant: {
                primary:
                    "pc-pressable pc-pressable-accent bg-accent-primary font-semibold text-text-on-accent hover:bg-accent-primary-hover active:bg-accent-primary-active",
                light:
                    "pc-pressable bg-light-white font-semibold text-text-on-light shadow-[var(--glow-light-fill)] hover:brightness-[1.04] active:brightness-[0.96]",
                ghost:
                    "pc-pressable bg-transparent text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary active:bg-bg-mod-strong",
                danger:
                    "pc-pressable bg-danger-well font-semibold text-accent-danger hover:brightness-125 active:brightness-95",
                // ---- legacy aliases (deprecated) ----
                default:
                    "pc-pressable pc-pressable-accent bg-accent-primary font-semibold text-text-on-accent hover:bg-accent-primary-hover active:bg-accent-primary-active",
                destructive:
                    "pc-pressable bg-danger-well font-semibold text-accent-danger hover:brightness-125 active:brightness-95",
                secondary:
                    "pc-pressable bg-bg-raised text-text-primary shadow-[var(--shadow-chip)] hover:bg-bg-mod-strong",
                outline:
                    "pc-pressable border border-border-subtle bg-transparent text-text-primary hover:bg-bg-mod-subtle",
                link: "px-1 py-0 text-text-link underline-offset-4 hover:underline",
            },
            size: {
                // pc-touch (§9, primitives.css): on a coarse pointer the hit
                // area is carried out to 44px around the control without
                // changing the control. `sm` is 28px everywhere, and an
                // icon-only `md` is ~38px wide however tall it is — both were
                // targets a thumb had to aim at. A control already 44px in a
                // dimension keeps that dimension (`max(100%, 44px)`).
                sm: "pc-touch h-[var(--h-control-sm)] px-2.5 text-meta",
                md: "pc-touch h-[var(--h-control)] px-[11px]",
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
    extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "ref">,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean;
    loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, loading, children, disabled, type = "button", ...props }, ref) => {
        return (
            <button
                ref={ref}
                type={type}
                className={cn(buttonVariants({ variant, size, className }))}
                disabled={disabled || loading}
                {...props}
            >
                {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {children}
            </button>
        );
    }
);
Button.displayName = "Button";

export { Button, buttonVariants };
