import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Button (docs/glass-spec.md §1.4, §1.5, §2.3, §9), on the same roles as the
 * Glass primitives in `components/glass/primitives` (GlassButton):
 *
 *   primary  cream, dark ink, hover white, press #e8e3d8 (Join). The ONE filled
 *            button on a screen: use it only where it is THE primary action of
 *            the dialog or page ("Save changes", "Log in", "Confirm").
 *   ghost    a text decision: transparent, ink, a wash on hover, a darker one on
 *            press ("Cancel", "Back", "Skip").
 *   glass    a control you press over content: a white fill at 12%, one step
 *            lighter on hover, one darker on press. For an action that is not
 *            the primary one ("Upload", "Copy", "Add").
 *   danger   the danger *well* carrying the one danger ink: the button that
 *            makes a destructive choice ("Delete channel", "Leave server").
 *            Never a red fill.
 *
 * Sizes: sm 32, md 36 (default), lg 44 (phone and the auth screens). Capsules
 * for primary and glass, radius 12 for ghost (a text button). Hover is one
 * token step lighter, press one step darker, 120ms ease-out; nothing scales.
 *
 * Legacy variant/size names (`default`, `destructive`, `secondary`, `outline`,
 * `light`, `link`) are kept as aliases so the un-restyled app keeps building:
 * `light` is the same cream as `primary` (Join is the light fill), `secondary`
 * and `outline` are `glass`.
 */
const PRIMARY =
    "rounded-[var(--r-capsule)] bg-accent-primary text-text-on-accent hover:bg-accent-primary-hover active:bg-accent-primary-active";
// `light` is the same cream (`--light-white` is `--join`); it keeps its own
// token classes so a caller that asks for "the light fill" still gets exactly that.
const LIGHT =
    "rounded-[var(--r-capsule)] bg-light-white text-text-on-light hover:bg-accent-primary-hover active:bg-accent-primary-active";
const GLASS =
    "rounded-[var(--r-capsule)] bg-[var(--glass-fill)] text-text-primary shadow-[var(--glass-edge)] hover:bg-[var(--glass-fill-hover)] active:bg-[var(--glass-fill-press)] aria-pressed:bg-[var(--glass-fill-on)]";
const DANGER =
    "rounded-[var(--r-capsule)] bg-danger-well text-accent-danger hover:bg-danger-well-hover active:[background-image:linear-gradient(var(--wash-press),var(--wash-press))]";

const buttonVariants = cva(
    [
        // pc-focusable: the §9 ring (focus.css).
        "pc-focusable",
        "relative inline-flex select-none items-center justify-center gap-[7px] whitespace-nowrap",
        "font-semibold outline-none",
        // Color only, over --duration-fast on the one ease-out (§9). A press
        // never moves or resizes the button.
        "transition-[background-color,color] duration-[var(--glass-ms)] ease-[var(--glass-ease)]",
        "disabled:pointer-events-none disabled:opacity-40",
    ].join(" "),
    {
        variants: {
            variant: {
                primary: PRIMARY,
                light: LIGHT,
                ghost:
                    "rounded-[var(--r-ctl)] bg-transparent text-text-primary hover:bg-[var(--wash-hover)] active:bg-[var(--wash-press)]",
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
                sm: "pc-touch h-8 px-3.5 text-[13px]",
                md: "pc-touch h-9 px-4 text-name",
                lg: "h-[var(--h-control-phone)] px-5 text-name",
                icon: "h-9 w-9 p-0 text-name",
                "icon-lg": "h-[var(--h-control-phone)] w-[var(--h-control-phone)] p-0 text-name",
                // ---- legacy alias (deprecated) ----
                default: "h-9 px-4 text-name",
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
