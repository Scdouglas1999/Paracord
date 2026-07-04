import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OccupantStack } from './OccupantStack';
import type { VoiceState } from '../../types';

function vs(partial: Partial<VoiceState> & { user_id: string }): VoiceState {
  return {
    session_id: `session-${partial.user_id}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    ...partial,
  };
}

describe('OccupantStack', () => {
  it('applies the speaking ring only to users in speakingUsers', () => {
    render(
      <OccupantStack
        participants={[
          vs({ user_id: 'u1', username: 'Alice' }),
          vs({ user_id: 'u2', username: 'Bob' }),
        ]}
        speakingUsers={new Set(['u1'])}
      />,
    );

    const speaking = screen.getByTestId('occupant-u1');
    const quiet = screen.getByTestId('occupant-u2');

    expect(speaking.className).toContain('ring-accent-primary');
    expect(quiet.className).not.toContain('ring-accent-primary');
    expect(quiet.className).toContain('ring-bg-secondary');
  });

  it('renders nothing when there are no participants', () => {
    const { container } = render(
      <OccupantStack participants={[]} speakingUsers={new Set()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('collapses overflow past max into a +N chip', () => {
    render(
      <OccupantStack
        participants={[
          vs({ user_id: 'u1' }),
          vs({ user_id: 'u2' }),
          vs({ user_id: 'u3' }),
          vs({ user_id: 'u4' }),
        ]}
        speakingUsers={new Set()}
        max={2}
      />,
    );

    expect(screen.getByTestId('occupant-u1')).toBeTruthy();
    expect(screen.getByTestId('occupant-u2')).toBeTruthy();
    expect(screen.queryByTestId('occupant-u3')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('surfaces a streaming badge for streaming occupants', () => {
    render(
      <OccupantStack
        participants={[vs({ user_id: 'u1', username: 'Zoe', self_stream: true })]}
        speakingUsers={new Set()}
      />,
    );
    expect(screen.getByLabelText('Zoe is streaming')).toBeTruthy();
  });
});
