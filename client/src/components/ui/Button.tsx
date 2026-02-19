import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { motion, HTMLMotionProps } from "framer-motion";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
    "inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-bg-primary transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 select-none",
    {
        variants: {
            variant: {
                default: "border border-transparent bg-accent-primary text-white shadow-[0_10px_24px_rgba(235,77,75,0.32)] hover:-translate-y-0.5 hover:bg-accent-primary-hover",
                destructive:
                    "border border-transparent bg-accent-danger text-white hover:bg-red-700",
                outline:
                    "border border-border-subtle bg-bg-mod-subtle/40 text-text-primary hover:bg-bg-mod-subtle",
                secondary:
                    "border border-transparent bg-accent-success text-white hover:bg-green-600",
                ghost: "border border-transparent text-text-secondary hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary",
                link: "text-text-link underline-offset-4 hover:underline",
            },
            size: {
                default: "h-10 px-4 py-2",
                sm: "h-9 px-3",
                lg: "h-11 px-8",
                icon: "h-10 w-10",
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
    ({ className, variant, size, loading, children, disabled, ...props }, ref) => {
        return (
            <motion.button
                ref={ref}
                whileTap={{ scale: 0.98 }}
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
