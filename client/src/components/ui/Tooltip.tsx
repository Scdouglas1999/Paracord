import * as React from "react";
import { useState, useRef, useCallback, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
// §5.1/§5.3: the small-surface recipe (pc-pop-in / pc-pop-out), grown from the
// side that faces the trigger, and the ONE reduced-motion switch — the
// presence hook keeps the tooltip mounted for its leave.
import { anchorOrigin, usePresence } from '../../lib/motion';
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
    const { mounted, exiting, scenery } = usePresence(isVisible);
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

    // Recalculate position when tooltip becomes visible or content changes.
    // The last coords are kept through the exit beat so the leave plays where
    // the tooltip was — they only go stale when the node unmounts.
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
    };

    // A tap focuses the control it lands on, so opening on every focus pinned
    // the tooltip open until something else took focus: on a phone, tapping a
    // Stage control left its label sitting on top of the control beside it for
    // as long as you looked at the screen. `:focus-visible` is the browser's
    // own answer to "did a keyboard do this", which is the only focus a tooltip
    // is for — a pointer user already knows what they just touched.
    const showTooltipOnFocus = (event: React.FocusEvent<HTMLDivElement>) => {
        const target = event.target as Element | null;
        try {
            if (target && !target.matches(":focus-visible")) return;
        } catch {
            // An engine without :focus-visible keeps the old behaviour.
        }
        showTooltip();
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
            // A tooltip for a control that opens something has to let go when
            // you use it. The pointer never leaves the trigger — the dialog
            // just appears underneath it — so no mouseleave ever fires, and the
            // label stayed pinned at z-9999 on top of the dialog it opened
            // ("Open user settings" over the settings panel, "Building
            // settings" over the building panel). Acting on the control is
            // reason enough to drop its label: you already know what you
            // pressed.
            onPointerDown={hideTooltip}
            onFocus={showTooltipOnFocus}
            onBlur={hideTooltip}
            aria-describedby={isVisible ? tooltipId : undefined}
        >
            {children}
            {createPortal(
                mounted && (
                    <div
                        ref={tooltipRef}
                        id={tooltipId}
                        role="tooltip"
                        className={cn(
                            // A floating surface (spec §4): --bg-floating + the plate
                            // shadow. No backdrop blur — over Linux underlay holes a
                            // translucent tooltip composites into the live stream and
                            // can stick there as a ghost label.
                            "pc-floating pointer-events-none fixed z-[9999] whitespace-nowrap px-2.5 py-1.5 text-meta font-medium text-text-primary",
                            exiting ? "pc-pop-out" : "pc-pop-in",
                            className
                        )}
                        style={{
                            top: coords?.top ?? -9999,
                            left: coords?.left ?? -9999,
                            '--pc-origin': anchorOrigin(side),
                        } as React.CSSProperties}
                        {...scenery}
                    >
                        {content}
                        {/* Arrow */}
                        <div
                            className={cn(
                                "absolute h-2 w-2 rotate-45 bg-bg-floating",
                                arrowPositions[side]
                            )}
                        />
                    </div>
                ),
                document.body
            )}
        </div>
    );
}
