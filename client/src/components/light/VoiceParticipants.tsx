import { nameList, type RoomLight } from '../../lib/attention/light';
import { avatarForScope, useAvatarScope } from '../../hooks/useScopedAvatar';
import { cn } from '../../lib/utils';
import { AvatarStack } from './AvatarStack';
import { LitAvatar } from './LitAvatar';

interface VoiceParticipantsProps {
  room: RoomLight;
  compact?: boolean;
  className?: string;
}

/** Faces are the preview of a call when there is no picture to show. */
export function VoiceParticipants({ room, compact = false, className }: VoiceParticipantsProps) {
  const avatarScope = useAvatarScope();
  const people = room.occupants.map(({ person }) => ({
    ...person,
    avatar: avatarForScope(person.avatar, room.scope, avatarScope),
  }));
  if (people.length === 0) return null;

  if (compact) {
    return (
      <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
        <AvatarStack people={people} size={30} max={2} room={room.channelId} aria-hidden />
        <span
          className="min-w-0 truncate text-meta text-text-primary"
          title={people.map((person) => person.name).join(', ')}
          aria-hidden
        >
          {nameList(people.map((person) => person.name), 2)}
        </span>
        <span className="sr-only">{nameList(people.map((person) => person.name), people.length)}</span>
      </div>
    );
  }

  const shown = people.slice(0, 3);
  const remaining = people.slice(shown.length);
  return (
    <ul
      aria-label={`In ${room.name}`}
      className={cn('grid min-w-0 gap-3', className)}
      style={{
        gridTemplateColumns: 'repeat(auto-fit, minmax(48px, 1fr))',
        maxWidth: (shown.length + Number(remaining.length > 0)) * 120,
      }}
    >
      {shown.map((person) => (
        <li key={person.userId} className="flex min-w-0 flex-col items-center gap-1.5">
          <LitAvatar person={person} size={44} room={room.channelId} hideLabel />
          <span className="line-clamp-2 w-full break-words text-center text-[13px] leading-5 text-text-primary" title={person.name}>
            {person.name}
          </span>
          <span className="sr-only">{person.label}</span>
        </li>
      ))}
      {remaining.length > 0 && (
        <li
          className="flex min-w-0 flex-col items-center gap-1.5"
          title={remaining.map((person) => person.name).join(', ')}
        >
          <span aria-hidden className="pc-display flex h-11 w-11 items-center justify-center rounded-full bg-bg-well text-name text-text-secondary">
            +{remaining.length}
          </span>
          <span className="text-[13px] leading-5 text-text-secondary" aria-hidden>more</span>
          <span className="sr-only">{remaining.map((person) => person.name).join(', ')}</span>
        </li>
      )}
    </ul>
  );
}
