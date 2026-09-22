import { useState } from 'react';
import type { SportsAthlete, SportsTeam } from '../../api/sports';
import { cn } from '../../lib/utils';
import { teamMonogram } from './model';

/** ESPN headshots and logos are https on espncdn only. Anything else is dropped. */
export function espnImage(url: string | null | undefined): string | null {
  const trimmed = url?.trim() ?? '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    if (!parsed.hostname.endsWith('espncdn.com')) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function TeamMark({ team, size = 'md' }: { team: SportsTeam; size?: 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const logo = espnImage(team.logo) && !failed ? team.logo.trim() : '';
  return (
    <span className={cn('pc-sports-logo-chip', size === 'lg' && 'is-lg')} aria-hidden>
      {logo ? (
        <img
          src={logo}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="pc-sports-logo"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="pc-sports-mark">{teamMonogram(team)}</span>
      )}
    </span>
  );
}

export function AthleteMark({ athlete }: { athlete: SportsAthlete | null | undefined }) {
  const [failed, setFailed] = useState(false);
  const src = !failed ? espnImage(athlete?.headshot) : null;
  const letter = (athlete?.short_name || athlete?.name || '').trim().slice(0, 1).toUpperCase();
  if (!src && !letter) return null;
  return (
    <span className="pc-sports-headshot" aria-hidden>
      {src ? (
        <img
          src={src}
          alt=""
          width={28}
          height={28}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="pc-sports-mark">{letter}</span>
      )}
    </span>
  );
}
