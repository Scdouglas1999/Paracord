import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import type React from "react";

/**
 * The design system's type steps (`--text-display` … `--text-section` in
 * src/styles/tokens.css) generate `text-*` utilities whose names are words, not
 * t-shirt sizes. tailwind-merge cannot tell `text-meta` (a font-size) from
 * `text-text-muted` (a colour) on its own, so out of the box it treats them as
 * the same class group and silently drops the first — `cn('text-meta
 * text-text-muted')` returned just `text-text-muted`, and every composed
 * component in the app lost its type step.
 *
 * Declaring the scale here is the fix: a `text-*` utility named below is a
 * font-size, and everything else `text-*` stays a colour.
 */
const TYPE_STEPS = [
  // Lantern Stage steps (docs/lantern-stage-spec.md §2).
  "display",
  "title",
  "heading",
  "name",
  "body",
  "ribbon",
  "label",
  "meta",
  "section",
  // Deprecated v1 step, still consumed by un-restyled surfaces.
  "subhead",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPE_STEPS] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * Fan one DOM node out to several refs — a forwarded ref plus a hook-owned
 * ref (the motion engine's settle/FLIP hooks hand back refs a component must
 * attach without owning the ref itself).
 */
export function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
    return (node: T | null) => {
        for (const ref of refs) {
            if (!ref) continue;
            if (typeof ref === "function") ref(node);
            else (ref as React.MutableRefObject<T | null>).current = node;
        }
    };
}
