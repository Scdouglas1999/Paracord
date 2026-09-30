import { InstrumentText } from '../primitives';

/**
 * The catch-up divider (docs/glass-spec.md §3.2): hairlines either side of
 * "6 new since 8:58" (instrument cut, 600) and a "Mark read" text button. It
 * sits above the first message you missed, drawn from the read position you
 * had when you opened the conversation.
 */
export function CatchUpDivider({ label, onMarkRead }: { label: string; onMarkRead: () => void }) {
  return (
    <div className="glass-catchup glass-tl-col" role="group" aria-label={label} data-testid="catch-up-divider">
      <span className="glass-catchup__rule" aria-hidden />
      <InstrumentText className="glass-catchup__label">{label}</InstrumentText>
      <button type="button" className="glass-catchup__mark glass-focusable" onClick={onMarkRead}>
        Mark read
      </button>
      <span className="glass-catchup__rule" aria-hidden />
    </div>
  );
}
