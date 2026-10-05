import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Button (docs/index-spec.md §3.1, §6.12), on the Index controls:
 *
 *   primary  the cream action (`--ix-cream`, dark ink, 14/700). The ONE filled
 *            button on a screen: use it only where it is THE primary action of
 *            the dialog or page ("Save changes", "Log in", "Confirm").
 *   ghost    a text decision: transparent, ink-2, a wash on hover ("Cancel",
 *            "Back", "Skip").
 *   glass    a quiet control (the control fill, ink): an action that is not the
 *            primary one ("Upload", "Copy", "Add"). The name is the Glass one;
 *            the look is the card's wide control.
 *   danger   the danger fill carrying the one danger ink: the button that makes
 *            a destructive choice ("Delete channel", "Leave server"). Never a
 *            red fill, and never cream.
 *
 * Sizes: sm 32, md 36 (default), lg 44 (phone and the entry pages). Radius 11
 * (10 at `sm`). Hover is one token step lighter, press one step darker, 55ms;
 * nothing scales.
 *
 * Legacy variant/size names (`default`, `destructive`, `secondary`, `outline`,
 * `light`, `link`) are kept as aliases so the un-restyled app keeps building:
 * `light` is the same cream as `primary`, `secondary` and `outline` are `glass`.
 */
const PRIMARY =
    "rounded-[11px] bg-accent-primary text-text-on-accent font-bold hover:bg-accent-primary-hover active:bg-accent-primary-active";
// `light` is the same cream (`--light-white` is `--join`); it keeps its own
// token classes so a caller that asks for "the light fill" still gets exactly that.
const LIGHT =
    "rounded-[11px] bg-light-white text-text-on-light font-bold hover:bg-accent-primary-hover active:bg-accent-primary-active";
const GLASS =
    "rounded-[11px] bg-[var(--ix-fill-ctl)] text-[var(--ix-ink)] hover:bg-[var(--ix-fill-ctl-hover)] active:bg-[var(--ix-fill-2)] aria-pressed:bg-[var(--ix-fill-2)]";
const DANGER =
    "rounded-[11px] bg-[var(--ix-danger-fill)] text-[var(--ix-danger-ink)] hover:bg-[var(--ix-danger-fill-call)] active:bg-[var(--ix-danger-fill-call)]";

const buttonVariants = cva(
    [
        // pc-focusable: the one focus ring (focus.css, ix-longtail.css).
        "pc-focusable",
        "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap",
        "font-semibold outline-none",
        // Color only, over 55ms on the one ease (§5.15). A press never moves
        // or resizes the button.
        "transition-[background-color,color] duration-[55ms] ease-[var(--ix-ease)]",
        "disabled:pointer-events-none disabled:opacity-[.45]",
    ].join(" "),
    {
        variants: {
            variant: {
                primary: PRIMARY,
                light: LIGHT,
                ghost:
                    "rounded-[11px] bg-transparent text-[var(--ix-ink-2)] hover:bg-[var(--ix-fill)] hover:text-[var(--ix-ink)] active:bg-[var(--ix-fill-2)]",
                glass: GLASS,
                danger: DANGER,
                // ---- legacy aliases (deprecated) ----
                default: PRIMARY,
                destructive: DANGER,
                secondary: GLASS,
                outline: GLASS,
                link: "rounded-[var(--r-chip)] px-1 py-0 font-medium text-text-primary underline underline-offset-4 hover:no-underline",
            },
            size: {
                // pc-touch (§9, primitives.css): on a coarse pointer the hit
                // area is carried out to 44px around the control without
                // changing the control.
                sm: "pc-touch h-8 rounded-[10px] px-3 text-[13.5px]",
                md: "pc-touch h-9 px-4 text-[14px]",
                lg: "h-[var(--h-control-phone)] rounded-[12px] px-5 text-[14.5px]",
                icon: "h-9 w-9 p-0 text-[14px]",
                "icon-lg": "h-[var(--h-control-phone)] w-[var(--h-control-phone)] p-0 text-[14px]",
                // ---- legacy alias (deprecated) ----
                default: "h-9 px-4 text-[14px]",
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
