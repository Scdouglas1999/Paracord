import { Well } from '../ui';
import { AvatarStack } from '../light';
import { lightsOnOverflowCaption, type PersonLight } from '../../lib/attention/light';

/** How many faces the well shows before the rest become the "+N lights on" tail. */
export const AROUND_NOW_FACES = 7;

export interface HomeAroundNowProps {
  /** The people the buildings can actually see — lit first (see `aroundNowPeople`). */
  people: readonly PersonLight[];
  /** WP1's one-sentence summary (`useAroundNow`). Never composed here. */
  sentence: string;
  /** Everyone with their lights on across every building. */
  lightsOn: number;
}

/**
 * Around now — the well under Home's title (docs/lantern-stage-spec.md §7.3, §7.5).
 *
 * A stack of lit faces, WP1's one sentence naming who is where, and the count
 * of everyone else whose lights are on. It asserts nothing of its own: every
 * face is a `PersonLight` and the sentence comes from `aroundNowSentence`, so
 * this cannot disagree with the sidebar or the Lobby.
 */
export function HomeAroundNow({ people, sentence, lightsOn }: HomeAroundNowProps) {
  // Only the faces actually on screen count against the tail, and only the lit
  // ones: the stack can carry a dim face, and "+N lights on" must stay a count
  // of lights rather than of avatars.
  const shownLit = people
    .slice(0, AROUND_NOW_FACES)
    .filter((person) => person.level === 'on').length;
  const overflow = Math.max(0, lightsOn - shownLit);

  return (
    <Well
      bare
      as="section"
      aria-label="Around now"
      className="flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-[var(--radius-card)] px-3.5 py-2.5"
    >
      <span className="shrink-0 text-meta text-text-faint">Around now</span>
      {people.length > 0 && (
        <AvatarStack people={people} size={28} max={AROUND_NOW_FACES} overlap={6} />
      )}
      {/* Narrow: the faces and the count keep the first line and the sentence
          wraps under them, rather than being squeezed into a column. */}
      <p className="order-2 min-w-0 flex-1 basis-full text-[13px] leading-snug text-text-body sm:order-none sm:basis-0">
        {sentence}
      </p>
      {overflow > 0 && (
        <span className="order-1 ml-auto shrink-0 text-meta text-text-faint sm:order-none">
          {lightsOnOverflowCaption(overflow)}
        </span>
      )}
    </Well>
  );
}
