import { useEffect, useId, useRef, type ReactNode } from 'react';

export type ScreenState = 'on' | 'past' | 'next';

/**
 * One step of the flow column (docs/setup-spec.md §1.1): heading, sub line,
 * the step's fields in a column that scrolls when the window is short, and the
 * footer pinned to the bottom (Back, then the cream primary). Enter submits
 * (the primary when it is enabled). A leaving step slides 16 px the way the
 * flow went and fades; the entering one comes from the other side, 200 ms,
 * 40 ms after (firstRun.css `.fr-scr`). Focus moves to the step's first field
 * once it has entered.
 */
export function Screen({
  step,
  state,
  title,
  sub,
  mark,
  onSubmit,
  footer,
  children,
}: {
  step: string;
  state: ScreenState;
  title: ReactNode;
  sub?: ReactNode;
  /** Drawn above the heading, in the top padding (the Setup step's mark). */
  mark?: ReactNode;
  onSubmit?: () => void;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  const on = state === 'on';

  useEffect(() => {
    if (!on) return;
    const timer = window.setTimeout(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      const field = root.querySelector<HTMLElement>('input:not([type=checkbox]):not([readonly]):not([disabled])');
      field?.focus({ preventScroll: true });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [on]);

  return (
    <section ref={ref} className="fr-scr" data-state={state} data-step={step} aria-labelledby={titleId} inert={!on} aria-hidden={on ? undefined : true}>
      {mark}
      <form
        className="fr-scr__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <div className="fr-scr__body">
          <h2 id={titleId}>{title}</h2>
          {sub && <p className="fr-sub">{sub}</p>}
          {children}
        </div>
        {footer && <div className="fr-foot">{footer}</div>}
      </form>
    </section>
  );
}
