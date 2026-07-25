import { Check, ChevronRight } from 'lucide-react';

export interface SetupStep {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  action: () => void;
  actionLabel: string;
}

interface HomeSetupChecklistProps {
  steps: SetupStep[];
}

/**
 * "Get set up" — shown on Home while a new account still has open steps.
 *
 * Home used to bottom out after a greeting and four small buttons, leaving most
 * of the canvas empty for exactly the accounts that needed guidance most. This
 * fills that space with real progress rather than decoration: every row is a
 * live check against store state, and the whole block disappears for good once
 * the last step is done.
 */
export function HomeSetupChecklist({ steps }: HomeSetupChecklistProps) {
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  const next = steps.find((s) => !s.done);

  return (
    <section aria-label="Get set up">
      <div className="mb-2.5 flex items-baseline justify-between gap-3 px-0.5">
        <span className="text-section uppercase text-text-muted">Get set up</span>
        <span className="text-meta tabular-nums text-text-muted">
          {doneCount} of {steps.length}
        </span>
      </div>

      <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
        {/* Progress hairline — quiet, not a loud gamified bar. */}
        <div className="h-0.5 w-full bg-bg-mod-subtle" aria-hidden>
          <div
            className="h-full bg-accent-primary transition-[width] duration-500 ease-[var(--ease-out)]"
            style={{ width: `${(doneCount / steps.length) * 100}%` }}
          />
        </div>

        <ul className="divide-y divide-border-subtle">
          {steps.map((step) => {
            const isNext = step.key === next?.key;
            return (
              <li key={step.key}>
                <button
                  type="button"
                  onClick={step.action}
                  disabled={step.done}
                  className={`flex w-full items-center gap-3.5 px-4 py-3.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] ${
                    step.done
                      ? 'cursor-default'
                      : 'hover:bg-bg-mod-subtle'
                  }`}
                >
                  {/* Only a completed step shows a check. The next step gets an
                      accent ring — an accent check would read as already done. */}
                  <span
                    className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border transition-colors ${
                      step.done
                        ? 'border-accent-success bg-accent-success text-white'
                        : isNext
                          ? 'border-accent-primary'
                          : 'border-border-strong'
                    }`}
                    aria-hidden
                  >
                    {step.done && <Check size={13} strokeWidth={3} />}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-label ${
                        step.done ? 'text-text-muted line-through' : 'text-text-primary'
                      }`}
                    >
                      {step.label}
                    </span>
                    {!step.done && (
                      <span className="mt-0.5 block text-meta text-text-secondary">
                        {step.hint}
                      </span>
                    )}
                  </span>

                  {!step.done && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-meta font-semibold text-accent-primary">
                      {step.actionLabel}
                      <ChevronRight size={14} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
