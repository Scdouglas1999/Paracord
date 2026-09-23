import { AvatarStack } from '../light';
import { lightsOnOverflowCaption, type PersonLight } from '../../lib/attention/light';

/** How many faces the quiet Home header shows before its overflow caption. */
export const AROUND_NOW_FACES = 7;

export interface HomeAroundNowProps {
  /** The people the buildings can actually see — lit first (see `aroundNowPeople`). */
  people: readonly PersonLight[];
  /** WP1's one-sentence summary (`useAroundNow`). Never composed here. */
  sentence: string;
  /** Everyone online across every server. */
  lightsOn: number;
  /** Voice cards already name their people; avoid repeating those faces above them. */
  showFaces?: boolean;
}

/**
 * Around now — the plain presence summary under Home's greeting (§7.5).
 *
 * The sentence names who is where. When voice cards are absent, faces and a
 * remaining-person count accompany it. It asserts nothing of its own: every
 * face is a `PersonLight` and the sentence comes from `aroundNowSentence`, so
 * this cannot disagree with the sidebar or the Lobby.
 */
export function HomeAroundNow({ people, sentence, lightsOn, showFaces = true }: HomeAroundNowProps) {
  // Only the faces actually on screen count against the tail, and only the lit
  // ones: the stack can carry a dim face, and "+N online" must stay a count
  // of people online rather than of avatars.
  const shownLit = people
    .slice(0, AROUND_NOW_FACES)
    .filter((person) => person.level === 'on').length;
  const overflow = Math.max(0, lightsOn - shownLit);

  return (
    <section
      aria-label="Around now"
      className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-3"
    >
      <p className="w-full min-w-0 text-label leading-relaxed text-text-secondary">
        {sentence}
      </p>
      {showFaces && people.length > 0 && (
        <AvatarStack people={people} size={36} max={AROUND_NOW_FACES} overlap={5} />
      )}
      {showFaces && overflow > 0 && (
        <span className="text-meta text-text-faint">
          {lightsOnOverflowCaption(overflow)}
        </span>
      )}
    </section>
  );
}
