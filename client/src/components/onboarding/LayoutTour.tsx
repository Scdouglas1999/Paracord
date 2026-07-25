import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import {
  getVersionedStorageItem,
  setVersionedStorageItem,
} from '../../lib/versionedStorage';

/**
 * LayoutTour — a one-time, dismissible coach-mark sequence that orients users to
 * the novel IA introduced in the v1.0 overhaul (layout-spec §1: unified attention
 * sidebar + presence-first guild homes). It is NOT a modal wizard: no full-app
 * dimming overlay — the app stays fully interactive and each step simply anchors a
 * small popover (design-spec §7 Popover) beside an existing landmark and paints a
 * soft emerald focus ring (design-spec §4 `--focus-ring`) over it.
 *
 * Two independent, separately-persisted tours run from this single mount:
 *   • the SHELL tour (steps a + b) fires on the first authenticated shell mount —
 *       (a) the unified sidebar region, (b) the search field / ⌘K entry;
 *   • the GUILD-HOME tour (step c) fires on the first guild-home (Rooms) visit —
 *       (c) the live-rooms area.
 *
 * Anchoring rule (layout-spec: do not edit the sidebar/rooms components, they are
 * being reworked concurrently): every step targets a STABLE aria landmark the
 * existing components already expose. A step whose anchor is absent is skipped
 * silently. Dismissal ("Skip tour", "Done", or Esc) persists via the shared
 * versioned-storage helper so the tour never re-appears.
 *
 * Motion follows design-spec §5 (≤180ms ease-out enter) and inherits AppShell's
 * `MotionConfig reducedMotion="user"`, so reduced-motion users get the fade only.
 */

type TourName = 'shell' | 'guild';

interface TourStepDef {
  id: string;
  /** A stable, already-exposed selector for the anchored landmark. */
  selector: string;
  body: string;
  /** Preferred placement of the popover relative to the anchor. */
  side: 'right' | 'top';
}

const SHELL_STEPS: TourStepDef[] = [
  {
    id: 'sidebar',
    selector: 'aside[aria-label="Navigation"]',
    body: 'Everything that needs you, in one place: mentions, DMs, and your spaces, ranked.',
    side: 'right',
  },
  {
    id: 'search',
    selector: '[aria-label="Search — open command palette"]',
    body: 'Jump anywhere instantly.',
    side: 'right',
  },
];

const GUILD_STEPS: TourStepDef[] = [
  {
    id: 'rooms',
    // LiveRoomsGrid labels its section "Live rooms" when occupied, else "Rooms".
    selector: 'section[aria-label="Live rooms"], section[aria-label="Rooms"]',
    body: "Spaces open on who's around — jump into a room or pick a channel below.",
    side: 'top',
  },
];

const SHELL_KEY = 'layout-tour-shell';
const GUILD_KEY = 'layout-tour-guild-home';
const DONE = 'done';
const BODY_ID = 'layout-tour-desc';
const TOOLTIP_W = 268;

const GUILD_HOME_PATH = /^\/app\/guilds\/[^/]+$/;

function stepsFor(tour: TourName): TourStepDef[] {
  return tour === 'shell' ? SHELL_STEPS : GUILD_STEPS;
}

/** Resolve an anchor only if it is actually laid out (guards jsdom / hidden). */
function findAnchor(selector: string): HTMLElement | null {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return el;
}

/** Place the popover beside the anchor, clamped inside the viewport. */
function computePosition(rect: DOMRect, side: 'right' | 'top'): { top: number; left: number } {
  const gap = 12;
  const margin = 12;
  const estHeight = 150;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top: number;
  let left: number;

  if (side === 'right') {
    left = rect.right + gap;
    top = rect.top + Math.min(24, rect.height * 0.1);
    if (left + TOOLTIP_W + margin > vw) {
      // No room to the right — drop below the anchor's top edge instead.
      left = rect.left;
      top = rect.bottom + gap;
    }
  } else {
    // Centered over the top edge of the anchor.
    left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
    top = rect.top + gap;
  }

  left = Math.min(Math.max(margin, left), vw - TOOLTIP_W - margin);
  top = Math.min(Math.max(margin, top), vh - estHeight - margin);
  return { top, left };
}

export function LayoutTour() {
  const location = useLocation();
  const isGuildHome = GUILD_HOME_PATH.test(location.pathname);

  const [shellDone, setShellDone] = useState(() => getVersionedStorageItem(SHELL_KEY) === DONE);
  const [guildDone, setGuildDone] = useState(() => getVersionedStorageItem(GUILD_KEY) === DONE);
  const [active, setActive] = useState<{ tour: TourName; index: number } | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const tooltipRef = useRef<HTMLDivElement>(null);
  const focusedStepRef = useRef<string | null>(null);

  const finish = useCallback((tour: TourName) => {
    if (tour === 'shell') {
      setVersionedStorageItem(SHELL_KEY, DONE);
      setShellDone(true);
    } else {
      setVersionedStorageItem(GUILD_KEY, DONE);
      setGuildDone(true);
    }
    focusedStepRef.current = null;
    setActive(null);
  }, []);

  const next = useCallback(() => {
    if (!active) return;
    const steps = stepsFor(active.tour);
    for (let i = active.index + 1; i < steps.length; i += 1) {
      if (findAnchor(steps[i].selector)) {
        focusedStepRef.current = null;
        setActive({ tour: active.tour, index: i });
        return;
      }
    }
    finish(active.tour);
  }, [active, finish]);

  const skip = useCallback(() => {
    if (active) finish(active.tour);
  }, [active, finish]);

  // Start the SHELL tour on the first authenticated shell mount. The sidebar
  // anchor is rendered synchronously, but retry across a few frames so a slow
  // first paint still lands the coach-mark. Steps with no anchor are skipped.
  useEffect(() => {
    if (shellDone || active) return undefined;
    let raf = 0;
    let tries = 0;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      const idx = SHELL_STEPS.findIndex((s) => findAnchor(s.selector));
      if (idx >= 0) {
        setActive({ tour: 'shell', index: idx });
        return;
      }
      if (tries < 30) {
        tries += 1;
        raf = requestAnimationFrame(attempt);
      }
    };
    attempt();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [shellDone, active]);

  // Start the GUILD-HOME tour on the first Rooms visit. The rooms section mounts
  // after channels load, so poll a bounded number of frames for its anchor; if it
  // never appears (e.g. the guild is unreachable) the step is skipped silently and
  // stays un-persisted so it can still fire on a later visit.
  useEffect(() => {
    if (guildDone || active || !isGuildHome) return undefined;
    let raf = 0;
    let tries = 0;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      if (findAnchor(GUILD_STEPS[0].selector)) {
        setActive({ tour: 'guild', index: 0 });
        return;
      }
      if (tries < 40) {
        tries += 1;
        raf = requestAnimationFrame(attempt);
      }
    };
    attempt();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [guildDone, active, isGuildHome]);

  // Track the anchor's position while a step is active — it follows scroll (inner
  // panes scroll too, hence capture) and resize so the ring/popover stay glued.
  useEffect(() => {
    if (!active) {
      setRect(null);
      return undefined;
    }
    const step = stepsFor(active.tour)[active.index];
    const update = () => {
      const el = findAnchor(step.selector);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [active]);

  // Move focus to the popover once per step (not on every scroll reposition), so
  // keyboard/screen-reader users land on the coach-mark (WCAG 2.4.3).
  useEffect(() => {
    if (!active || !rect) return undefined;
    const key = `${active.tour}:${active.index}`;
    if (focusedStepRef.current === key) return undefined;
    focusedStepRef.current = key;
    const id = requestAnimationFrame(() => tooltipRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [active, rect]);

  if (!active || !rect) return null;

  const steps = stepsFor(active.tour);
  const step = steps[active.index];
  if (!step) return null;

  const hasMore = steps
    .slice(active.index + 1)
    .some((s) => findAnchor(s.selector));
  const pos = computePosition(rect, step.side);

  return createPortal(
    <>
      {/* Soft emerald highlight ring over the anchored landmark (no app-wide dim). */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          top: rect.top - 4,
          left: rect.left - 4,
          width: rect.width + 8,
          height: rect.height + 8,
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--focus-ring)',
          pointerEvents: 'none',
          zIndex: 118,
        }}
      />

      <motion.div
        ref={tooltipRef}
        role="dialog"
        aria-label="Get to know your workspace"
        aria-describedby={BODY_ID}
        tabIndex={-1}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            skip();
          }
        }}
        style={{ position: 'fixed', top: pos.top, left: pos.left, width: TOOLTIP_W }}
        className="z-[120] rounded-md border border-border-subtle bg-bg-floating p-3 shadow-lg outline-none"
      >
        <p id={BODY_ID} className="text-meta leading-relaxed text-text-primary">
          {step.body}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-meta tabular-nums text-text-muted">
            {steps.length > 1 ? `${active.index + 1} of ${steps.length}` : ''}
          </span>
          <div className="flex items-center gap-1">
            {hasMore && (
              <button
                type="button"
                onClick={skip}
                className="rounded-sm px-2 py-1 text-meta font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
              >
                Skip tour
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="rounded-sm bg-accent-tint px-2.5 py-1 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint-strong focus-visible:shadow-[var(--focus-ring)]"
            >
              {hasMore ? 'Next' : 'Done'}
            </button>
          </div>
        </div>
      </motion.div>
    </>,
    document.body,
  );
}
