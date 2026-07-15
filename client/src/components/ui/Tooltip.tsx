import * as React from "react";
import { useState, useRef, useCallback, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { cn } from "../../lib/utils";

interface TooltipProps {
    content: string;
    children: React.ReactNode;
    side?: "top" | "right" | "bottom" | "left";
    delay?: number;
    className?: string;
}

const GAP = 8; // space between trigger and tooltip

export function Tooltip({
    content,
    children,
    side = "top",
    delay = 0,
    className,
}: TooltipProps) {
    const [isVisible, setIsVisible] = useState(false);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
    const reduceMotion = useReducedMotion();
    const tooltipId = useId();
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const triggerRef = useRef<HTMLDivElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current;
        const tooltip = tooltipRef.current;
        if (!trigger || !tooltip) return;

        const rect = trigger.getBoundingClientRect();
        const tipRect = tooltip.getBoundingClientRect();

        let top = 0;
        let left = 0;

        switch (side) {
            case "top":
                top = rect.top - tipRect.height - GAP;
                left = rect.left + rect.width / 2 - tipRect.width / 2;
                break;
            case "bottom":
                top = rect.bottom + GAP;
                left = rect.left + rect.width / 2 - tipRect.width / 2;
                break;
            case "right":
                top = rect.top + rect.height / 2 - tipRect.height / 2;
                left = rect.right + GAP;
                break;
            case "left":
                top = rect.top + rect.height / 2 - tipRect.height / 2;
                left = rect.left - tipRect.width - GAP;
                break;
        }

        // Clamp to viewport
        left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
        top = Math.max(4, Math.min(top, window.innerHeight - tipRect.height - 4));

        setCoords({ top, left });
    }, [side]);

    // Recalculate position when tooltip becomes visible or content changes
    useLayoutEffect(() => {
        if (isVisible) {
            updatePosition();
        }
    }, [isVisible, content, updatePosition]);

    const showTooltip = () => {
        timeoutRef.current = setTimeout(() => setIsVisible(true), delay);
    };

    const hideTooltip = () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setIsVisible(false);
        setCoords(null);
    };

    const arrowPositions = {
        top: "bottom-[-4px] left-1/2 -translate-x-1/2",
        right: "left-[-4px] top-1/2 -translate-y-1/2",
        bottom: "top-[-4px] left-1/2 -translate-x-1/2",
        left: "right-[-4px] top-1/2 -translate-y-1/2",
    };

    return (
        <div
            ref={triggerRef}
            className="relative flex items-center justify-center"
            onMouseEnter={showTooltip}
            onMouseLeave={hideTooltip}
            onFocus={showTooltip}
            onBlur={hideTooltip}
            aria-describedby={isVisible ? tooltipId : undefined}
        >
            {children}
            {createPortal(
                <AnimatePresence>
                    {isVisible && (
                        <motion.div
                            ref={tooltipRef}
                            id={tooltipId}
                            role="tooltip"
                            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
                            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                            className={cn(
                                // No backdrop-blur: over Linux underlay holes glass tooltips
                                // composite into the live stream and can stick as ghost labels.
                                "pointer-events-none fixed z-[9999] whitespace-nowrap rounded-sm border border-border-subtle bg-bg-secondary px-2.5 py-1.5 text-meta font-semibold text-text-primary shadow-lg",
                                className
                            )}
                            style={{
                                top: coords?.top ?? -9999,
                                left: coords?.left ?? -9999,
                            }}
                        >
                            {content}
                            {/* Arrow */}
                            <div
                                className={cn(
                                    "absolute w-2 h-2 bg-bg-secondary rotate-45",
                                    arrowPositions[side]
                                )}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
            )}
        </div>
    );
}
