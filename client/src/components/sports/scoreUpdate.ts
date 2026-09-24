import type { ChannelPin, SportsGame, SportsTeam } from '../../api/sports';

/** A score sentence posted by the Sports add-on. The words are the message content. */
export interface ScoreUpdate {
  label: string;
  leadName: string;
  leadScore: string;
  otherName: string;
  otherScore: string;
  clock: string | null;
  play: string | null;
  overtime: boolean;
}

const SCORING_LABEL = 'Touchdown|Field goal|Safety|Extra point|Two-point|Home run|Score';
const MARK_LABEL = 'Halftime|End of regulation|Final';

const scoringLine = new RegExp(
  `^(${SCORING_LABEL}) — (.+) (\\d+), (.+) (\\d+) · (.+?) · (.+)$`,
);
const markLine = new RegExp(
  `^(${MARK_LABEL}) — (.+) (\\d+), (.+) (\\d+)( \\(OT\\))?$`,
);

export function isSportsScoreAuthor(author: {
  bot?: boolean;
  username?: string;
  display_name?: string | null;
}): boolean {
  return author.bot === true && (author.username === 'Sports' || author.display_name === 'Sports');
}

/** The sentence, or null when this is not a score update. */
export function parseScoreUpdate(content: string): ScoreUpdate | null {
  const text = content.trim();
  const scoring = scoringLine.exec(text);
  if (scoring) {
    return {
      label: scoring[1],
      leadName: scoring[2],
      leadScore: scoring[3],
      otherName: scoring[4],
      otherScore: scoring[5],
      clock: scoring[6].trim() || null,
      play: scoring[7].trim() || null,
      overtime: false,
    };
  }
  const mark = markLine.exec(text);
  if (!mark) return null;
  return {
    label: mark[1],
    leadName: mark[2],
    leadScore: mark[3],
    otherName: mark[4],
    otherScore: mark[5],
    clock: null,
    play: null,
    overtime: Boolean(mark[6]),
  };
}

function sameTeam(team: SportsTeam, name: string): boolean {
  const needle = name.trim().toLowerCase();
  return [team.short_name, team.name, team.abbr].some((value) => value.trim().toLowerCase() === needle);
}

function namedTeam(name: string): SportsTeam {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const abbr = (words.length > 1 ? words.map((word) => word[0]).join('') : name.trim()).slice(0, 4).toUpperCase();
  return {
    id: name,
    abbr: abbr || name.slice(0, 3).toUpperCase(),
    name,
    short_name: name,
    logo: '',
    score: null,
    record: null,
    possession: false,
    winner: false,
  };
}

/** The pinned game for this channel, when the board still has it. */
export function scoreUpdateGame(
  entry: { settings?: { channel_pins?: ChannelPin[] } | null; board?: { games: SportsGame[] } | null } | undefined,
  channelId: string,
): SportsGame | null {
  const pin = entry?.settings?.channel_pins?.find((item) => item.channel_id === channelId);
  const games = entry?.board?.games;
  if (!pin || !games) return null;
  const parts = pin.game.split('/');
  if (parts.length < 3) return null;
  const eventId = parts[parts.length - 1];
  const leaguePath = parts.slice(0, -1).join('/');
  return games.find((game) => game.id === eventId && game.league_path === leaguePath) ?? null;
}

export function scoreUpdateHref(guildId: string, game: SportsGame | null): string | null {
  if (!guildId || !game) return null;
  return `/app/guilds/${guildId}/sports/${game.league_path}/${game.id}`;
}

/** Lead is the team named first. Real teams supply the logo and the color. */
export function resolveScoreSides(game: SportsGame | null, update: ScoreUpdate): { lead: SportsTeam; other: SportsTeam } {
  if (game && sameTeam(game.home, update.leadName)) return { lead: game.home, other: game.away };
  if (game && sameTeam(game.away, update.leadName)) return { lead: game.away, other: game.home };
  return { lead: namedTeam(update.leadName), other: namedTeam(update.otherName) };
}
