import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import {
  getVersionedStorageItem,
  setVersionedStorageItem,
} from '../../lib/versionedStorage';

/**
 * LayoutTour — a one-time, dismissible coach-mark sequence that orients users to
 * the novel IA introduced in the v1.0 overhaul (layout-spec §1: unified attention
 * sidebar + presence-first guild homes). It is NOT a modal wizard: no full-app
 * dimming overlay — the app stays fully interactive and each step simply anchors a
 * small popover (lantern-stage-spec §8) beside an existing landmark and paints a
 * soft emerald focus ring (lantern-stage-spec §9 focus ring) over it.
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
 * Motion is the shared §5.1 pc-enter recipe; the app's one reduced-motion
 * switch (utilities.css's `data-motion` rule) stills it.
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
    body: 'Everything that needs you, in one place: mentions, DMs, and your servers, ranked.',
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
    // The Lobby's rooms grid (§7.3). The older "Live rooms" label is kept in
    // the selector so a tour started against a stale bundle still finds it.
    selector: 'section[aria-label="Voice channels"], section[aria-label="Rooms"], section[aria-label="Live rooms"]',
    body: "Servers open on who's around — join a call or pick a channel below.",
    side: 'top',
  },
];

const SHELL_KEY = 'layout-tour-shell';
const GUILD_KEY = 'layout-tour-guild-home';
const DONE = 'done';
const BODY_ID = 'layout-tour-desc';
const TOOLTIP_W = 268;
/** How often a live step re-checks that its anchor is still on screen. */
const ANCHOR_POLL_MS = 250;

const GUILD_HOME_PATH = /^\/app\/guilds\/[^/]+$/;

/** How often a tour that is waiting its turn looks again. */
const START_POLL_MS = 300;

/**
 * Is another first-run surface already holding the screen?
 *
 * A brand-new phone user met three overlays in one session — the building's
 * welcome modal, the shell coach marks and the Lobby coach mark — and dismissed
 * all three before seeing the product. Each is fine; together they are a queue,
 * so a tour waits while a modal dialog is open and starts when it closes.
 */
function modalIsOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

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
    // Beside the MIDDLE of the anchor, not its top. `rect.top + min(24, …)`
    // capped out immediately on a full-height sidebar, so step one always
    // landed at y=24 — squarely on the page's own heading.
    top = rect.top + rect.height / 2 - estHeight / 2;
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
  const [coveredByModal, setCoveredByModal] = useState(false);
  useEffect(() => {
    if (!active) {
      setCoveredByModal(false);
      return undefined;
    }
    const check = () => setCoveredByModal(modalIsOpen());
    check();
    const timer = window.setInterval(check, START_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active]);

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
    let timer = 0;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      if (!modalIsOpen()) {
        const idx = SHELL_STEPS.findIndex((s) => findAnchor(s.selector));
        if (idx >= 0) {
          setActive({ tour: 'shell', index: idx });
          return;
        }
      }
      // Keep looking: the anchor may still be painting, or a welcome modal may
      // be in front of it waiting to be dismissed.
      timer = window.setTimeout(attempt, START_POLL_MS);
    };
    const raf = requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [shellDone, active]);

  // Start the GUILD-HOME tour on the first Rooms visit. The rooms section mounts
  // after channels load, so poll a bounded number of frames for its anchor; if it
  // never appears (e.g. the guild is unreachable) the step is skipped silently and
  // stays un-persisted so it can still fire on a later visit.
  useEffect(() => {
    // The Lobby's coach mark waits for the shell's: one at a time, the next on
    // dismissal of the one before it.
    if (guildDone || active || !isGuildHome) return undefined;
    let timer = 0;
    let tries = 0;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      // "Waits for the shell tour" means waits for it to be FINISHED — or for
      // it to be unable to run at all. On a phone the sidebar it anchors to is
      // a drawer that is not on screen, so a strict wait would hold the Lobby's
      // coach mark back for ever.
      const shellPending =
        !shellDone && SHELL_STEPS.some((step) => findAnchor(step.selector));
      if (!shellPending && !modalIsOpen() && findAnchor(GUILD_STEPS[0].selector)) {
        setActive({ tour: 'guild', index: 0 });
        return;
      }
      // Bounded: a building that never renders its rooms (unreachable, or no
      // permission) must not leave a timer running for the session.
      if (tries < 40) {
        tries += 1;
        timer = window.setTimeout(attempt, START_POLL_MS);
      }
    };
    const raf = requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [guildDone, active, isGuildHome, shellDone]);

  // Track the anchor's position while a step is active — it follows scroll (inner
  // panes scroll too, hence capture) and resize so the ring/popover stay glued.
  //
  // Scroll and resize are not enough on their own: an anchor can simply be
  // unmounted underneath a live step. At phone width the shell renders the
  // collapsed navigation rail for a beat and then swaps to the bottom tab bar,
  // which left the ring painted at the rail's last rectangle — a stray emerald
  // line down the whole screen, beside a popover describing a sidebar that is
  // no longer there. So poll as well, and when the anchor is gone move on to
  // the next reachable step (or finish) exactly as `next` does, rather than
  // leaving a coach-mark pinned to nothing.
  useEffect(() => {
    if (!active) {
      setRect(null);
      return undefined;
    }
    const step = stepsFor(active.tour)[active.index];
    const update = () => {
      const el = findAnchor(step.selector);
      if (!el) {
        setRect(null);
        next();
        return;
      }
      setRect(el.getBoundingClientRect());
    };
    update();
    const poll = window.setInterval(update, ANCHOR_POLL_MS);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [active, next]);

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

  // …and steps aside if one opens after it has started. The shell tour begins
  // on the first frame; a server's welcome dialog opens a moment later, once its
  // channels have loaded — so a new member's very first screen was a coach mark
  // sitting on top of the dialog welcoming them. It comes back when that closes.
  if (!active || !rect || coveredByModal) return null;

  const steps = stepsFor(active.tour);
  const step = steps[active.index];
  if (!step) return null;

  const hasMore = steps
    .slice(active.index + 1)
    .some((s) => findAnchor(s.selector));
  // Count only the steps this viewport can actually show. A step whose anchor
  // is absent is skipped silently, so "1 of 2" beside a Done button — which is
  // what a phone saw, where the search field does not exist — promises a second
  // card that never arrives.
  const reachable = steps.filter((s, i) => i === active.index || findAnchor(s.selector));
  const reachableIndex = reachable.findIndex((s) => s.id === step.id) + 1;
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
          borderRadius: 'var(--radius-well)',
          boxShadow: 'var(--focus-ring)',
          pointerEvents: 'none',
          zIndex: 118,
        }}
      />

      <div
        ref={tooltipRef}
        role="dialog"
        aria-label="Get to know your workspace"
        aria-describedby={BODY_ID}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            skip();
            return;
          }
          // A dialog keeps the keyboard. Without this, Tab from "Next" walked
          // straight out into the page behind — a keyboard user was inside an
          // overlay with nothing to tell them they had left it.
          if (e.key !== 'Tab') return;
          const stops = Array.from(
            tooltipRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
          );
          if (stops.length === 0) return;
          const first = stops[0];
          const last = stops[stops.length - 1];
          const activeEl = document.activeElement;
          if (e.shiftKey && (activeEl === first || activeEl === tooltipRef.current)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && (activeEl === last || activeEl === tooltipRef.current)) {
            e.preventDefault();
            first.focus();
          }
        }}
        style={{ position: 'fixed', top: pos.top, left: pos.left, width: TOOLTIP_W }}
        // Opaque, not the 97%-alpha floating surface: a coach-mark sits ON the
        // thing it is describing, and the display-size heading underneath was
        // ghosting through it legibly.
        className="pc-enter pc-coach z-[120] p-3 outline-none"
      >
        <p id={BODY_ID} className="text-label leading-relaxed text-text-primary">
          {step.body}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="pc-mono text-meta text-text-faint">
            {reachable.length > 1 ? `${reachableIndex} of ${reachable.length}` : ''}
          </span>
          <div className="flex items-center gap-1">
            {hasMore && (
              <button
                type="button"
                onClick={skip}
                className="pc-focusable inline-flex h-[var(--h-control)] items-center rounded-[var(--radius-control)] px-2.5 text-meta font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary"
              >
                Skip tour
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="pc-focusable inline-flex h-[var(--h-control)] items-center rounded-[var(--radius-control)] bg-accent-primary px-3 text-meta font-semibold text-text-on-accent transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:bg-accent-primary-active"
            >
              {hasMore ? 'Next' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
