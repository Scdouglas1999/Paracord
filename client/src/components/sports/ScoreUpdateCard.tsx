import { Link } from 'react-router';
import type { SportsTeam } from '../../api/sports';
import { teamPaint } from './gamecast';
import type { ScoreUpdate } from './scoreUpdate';
import { TeamMark } from './TeamMark';

/**
 * Compact score card for a Sports add-on message. Other surfaces keep the
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
  const paint = teamPaint(lead, other);
  const colored = Boolean(lead.color || lead.alt_color);
  const headline = update.overtime ? `${update.label} (OT)` : update.label;
  const body = (
    <>
      <span className="pc-sports-scorecard-line">
        <TeamMark team={lead} />
        <span className="pc-mono" style={colored ? { color: paint.fill } : undefined}>{update.leadScore}</span>
        <TeamMark team={other} />
        <span className="pc-mono text-text-primary">{update.otherScore}</span>
      </span>
      <span className="pc-sports-scorecard-line text-meta text-text-secondary">
        <span>{headline}</span>
        {update.clock && <span className="pc-mono">{update.clock}</span>}
      </span>
      {update.play && <span className="pc-sports-scorecard-play">{update.play}</span>}
    </>
  );
  if (!href) return <div className="pc-sports-scorecard">{body}</div>;
  return (
    <Link className="pc-sports-scorecard" to={href}>
      {body}
    </Link>
  );
}
