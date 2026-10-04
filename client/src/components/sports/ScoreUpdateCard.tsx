import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import type { SportsTeam } from '../../api/sports';
import { teamPaint } from './gamecast';
import type { ScoreUpdate } from './scoreUpdate';
import { TeamMark } from './TeamMark';

/**
 * A score for a Sports add-on message, as a card of the event-card family
 * (docs/index-spec.md §8.4): the two marks and their scores, what happened, the
 * play. A team's own color is a 2px rule under its score, never the score's
 * ink (a team color can be as dark as the card). Other surfaces keep the
 * sentence; only the message list renders this.
 */
export function ScoreUpdateCard({
  update,
  lead,
  other,
  href,
}: {
  update: ScoreUpdate;
  lead: SportsTeam;
  other: SportsTeam;
  href: string | null;
}) {
  const leadPaint = teamPaint(lead, other);
  const otherPaint = teamPaint(other, lead);
  const headline = update.overtime ? `${update.label} (OT)` : update.label;
  const rule = (team: SportsTeam, fill: string): CSSProperties | undefined =>
    team.color || team.alt_color ? ({ '--team': fill } as CSSProperties) : undefined;
  const body = (
    <>
      <span className="ix-score__line">
        <span className="ix-score__team">
          <TeamMark team={lead} />
          <span className="ix-score__n" style={rule(lead, leadPaint.fill)}>{update.leadScore}</span>
        </span>
        <span className="ix-score__team">
          <TeamMark team={other} />
          <span className="ix-score__n" style={rule(other, otherPaint.fill)}>{update.otherScore}</span>
        </span>
      </span>
      <span className="ix-score__what">
        <span>{headline}</span>
        {update.clock && <span className="ix-score__clock">{update.clock}</span>}
      </span>
      {update.play && <span className="ix-score__play">{update.play}</span>}
    </>
  );
  if (!href) return <div className="ix-card ix-score">{body}</div>;
  return (
    <Link className="ix-card ix-score" to={href}>
      {body}
    </Link>
  );
}
