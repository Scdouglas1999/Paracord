import { Face } from '../places/Lead';
import { rosterState, type PillOccupant } from './model';

/**
 * Who is in the channel and what each person is doing (docs/glass-spec.md §5):
 * "Sharing screen" and "Talking" in amber, "Muted" and "Listening in" in ink-2.
 * Talking and sharing wear an amber ring; light is never the only cue, so the
 * state is also written out.
 */
export interface PillRosterProps {
  /** For the list's accessible name: "In Lounge". */
  channelName: string;
  occupants: readonly PillOccupant[];
  /** While you listen in: the sentence that says everyone can see it. */
  listeningNote?: string | null;
}

export function PillRoster({ channelName, occupants, listeningNote }: PillRosterProps) {
  return (
    <div className="glass-pill__roster-wrap">
      <div className="glass-pill__roster-inner">
        <ul className="glass-pill__roster" aria-label={`In ${channelName}`}>
          {occupants.map((person) => {
            const state = rosterState(person);
            const lit = person.sharing || person.talking;
            return (
              <li key={person.userId} className="glass-pill__person" data-lit={lit ? 'true' : 'false'}>
                <Face face={{ userId: person.userId, name: person.name, avatar: person.avatar }} size={26} />
                <span className="glass-pill__person-name">{person.name}</span>
                <span className="glass-pill__person-state" data-tone={state.tone}>
                  {state.text}
                </span>
              </li>
            );
          })}
        </ul>
        {listeningNote && <p className="glass-pill__note">{listeningNote}</p>}
      </div>
    </div>
  );
}
