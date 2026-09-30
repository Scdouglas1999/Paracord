import { Face } from '../glass/places/Lead';
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
  /** Who is in a call right now (by user id): they lead, and wear the amber ring. */
  inCall?: ReadonlySet<string>;
}

/**
 * Around now — who is here, as faces, and one plain sentence about where
 * (docs/glass-spec.md §1.3: amber means live).
 *
 * The sentence names who is where. Faces and a remaining-person count accompany
 * it; somebody in a voice room wears the amber ring, everybody else just a face.
 * It asserts nothing of its own: every face is a `PersonLight` and the sentence
 * comes from `aroundNowSentence`, so this cannot disagree with the places panel
 * or a server's Overview.
 */
export function HomeAroundNow({ people, sentence, lightsOn, showFaces = true, inCall }: HomeAroundNowProps) {
  // Only the faces actually on screen count against the tail, and only the lit
  // ones: the stack can carry a dim face, and "+N online" must stay a count
  // of people online rather than of avatars.
  const isLive = (person: PersonLight) => person.live || Boolean(inCall?.has(person.userId));
  // Somebody in a call is the most "around" there is: they come first (the
  // order is otherwise the caller's, and a stable sort keeps it).
  const shown = [...people].sort((a, b) => Number(isLive(b)) - Number(isLive(a))).slice(0, AROUND_NOW_FACES);
  const shownLit = shown.filter((person) => person.level === 'on').length;
  const overflow = Math.max(0, lightsOn - shownLit);

  return (
    <div className="glass-around">
      {showFaces && shown.length > 0 && (
        <span className="glass-around__faces" role="img" aria-label={`Online: ${shown.map((person) => person.name).join(', ')}`}>
          {shown.map((person, index) => (
            <span
              key={person.userId}
              className="glass-around__face"
              data-live={isLive(person) ? '' : undefined}
              style={index === 0 ? undefined : { marginInlineStart: -6 }}
            >
              <Face face={{ userId: person.userId, name: person.name, avatar: person.avatar }} size={36} />
            </span>
          ))}
        </span>
      )}
      {showFaces && overflow > 0 && (
        <span className="glass-instrument glass-around__more">{lightsOnOverflowCaption(overflow)}</span>
      )}
      {sentence ? <p className="glass-around__line">{sentence}</p> : null}
    </div>
  );
}
