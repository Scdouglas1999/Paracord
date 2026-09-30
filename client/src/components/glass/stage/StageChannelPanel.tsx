import { useMemo, useState } from 'react';
import { Hand } from 'lucide-react';

import { usePermissions } from '../../../hooks/usePermissions';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { displayName } from '../../../lib/displayName';
import { entityScopeKey } from '../../../lib/serverScope';
import { useMemberStore } from '../../../stores/memberStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { hasPermission, Permissions, type VoiceState } from '../../../types';
import { TextField } from '../../ui/TextField';
import { GlassButton, Kicker } from '../primitives';
import { useStageChannel } from './useStageChannel';

const NOBODY: readonly VoiceState[] = [];

/**
 * A stage channel's session, over its chat (docs/design/glass-plan.md §8.4:
 * "stage channels use the stage look"; the call itself is the stage and the
 * pill, like any voice channel).
 *
 * What the Lantern voice page carried for a stage channel, in one strip:
 *   - everyone: whether the stage is open and its topic;
 *   - moderators (Manage channels): open the stage with a topic, save the topic,
 *     end it; raised hands with "Let them speak" and dismiss; who is speaking
 *     and who is listening, with "Move to the audience" and "Invite to speak";
 *   - the audience in the call: raise or lower a hand ("Request to speak"; the
 *     stage's control row has the same button).
 * The server's words go under it when a request fails.
 */
export function StageChannelPanel({ guildId, channelId, channelName }: { guildId: string; channelId: string; channelName: string }) {
  const scope = useCurrentAccountScope();
  const session = useStageChannel(channelId);
  const { permissions, isAdmin } = usePermissions(guildId);
  const canManage = isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS);
  const states = useVoiceStore((state) => state.channelParticipants.get(channelId) ?? NOBODY);
  // A voice state carries a username, not the name people use: the server's roster says it.
  const roster = useMemberStore((state) => (scope ? state.members.get(entityScopeKey(scope, guildId)) : undefined));
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of roster ?? []) names.set(member.user.id, displayName(member.user, member.nick));
    return (state: VoiceState) => names.get(state.user_id) ?? displayName(state);
  }, [roster]);
  const inThisCall = useVoiceStore((state) => state.connected && state.channelId === channelId);
  const [topic, setTopic] = useState(session.instance?.topic ?? '');
  const [manageOpen, setManageOpen] = useState(false);

  // The field starts from the stage's topic, and follows it when it changes
  // (adjusted while rendering, so no extra commit).
  const liveTopic = session.instance?.topic ?? '';
  const [seenTopic, setSeenTopic] = useState(liveTopic);
  if (seenTopic !== liveTopic) {
    setSeenTopic(liveTopic);
    setTopic(liveTopic);
  }

  const speakers = useMemo(() => states.filter((state) => !state.suppress), [states]);
  const audience = useMemo(() => states.filter((state) => state.suppress), [states]);
  const hands = useMemo(() => audience.filter((state) => state.request_to_speak_at), [audience]);
  const self = scope ? states.find((state) => state.user_id === scope.userId) : undefined;
  const selfAudience = inThisCall && self?.suppress !== false;
  const selfRaised = selfAudience && Boolean(self?.request_to_speak_at);

  const status = session.loading && !session.instance
    ? 'Looking for a live stage…'
    : session.instance
      ? session.instance.topic || channelName
      : 'Nobody has opened the stage yet.';

  const busy = session.busy || session.requestBusy;

  return (
    <section className="glass-stage-panel" aria-label={`${channelName} stage`}>
      <div className="glass-stage-panel__head">
        <div className="glass-stage-panel__what">
          <Kicker as="span" tone={session.instance ? 'amber' : 'ink'}>
            {session.instance ? 'Stage open' : 'Stage'}
          </Kicker>
          <span className="glass-stage-panel__topic" title={status}>
            {status}
          </span>
        </div>
        <div className="glass-stage-panel__actions">
          {selfAudience && session.instance && (
            <GlassButton
              variant="text"
              pressed={selfRaised}
              aria-disabled={session.requestBusy || undefined}
              title={selfRaised ? 'Lower your hand' : 'Ask the stage moderators to invite you to speak'}
              onClick={() => {
                if (!session.requestBusy) session.toggleRequest(selfRaised);
              }}
            >
              <Hand size={16} strokeWidth={1.8} aria-hidden="true" />
              {selfRaised ? 'Request sent' : 'Request to speak'}
            </GlassButton>
          )}
          {canManage && session.instance && (
            <GlassButton
              variant="text"
              aria-expanded={manageOpen}
              onClick={() => setManageOpen((open) => !open)}
            >
              {manageOpen ? 'Done' : 'Manage the stage'}
            </GlassButton>
          )}
        </div>
      </div>

      {canManage && (!session.instance || manageOpen) && (
        <div className="glass-stage-panel__manage">
          <TextField
            label="Topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="Weekly sync, product launch, Q&A…"
            maxLength={160}
          />
          <div className="glass-stage-panel__buttons">
            {!session.instance ? (
              <GlassButton
                variant="primary"
                aria-disabled={busy || undefined}
                aria-busy={session.busy || undefined}
                onClick={() => {
                  if (!busy) session.open(topic, channelName);
                }}
              >
                {session.busy ? 'Opening…' : 'Open the stage'}
              </GlassButton>
            ) : (
              <>
                <GlassButton
                  variant="glass"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) session.saveTopic(topic);
                  }}
                >
                  {session.busy ? 'Saving…' : 'Save the topic'}
                </GlassButton>
                <GlassButton
                  variant="text"
                  className="glass-stage-panel__end"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) session.end();
                  }}
                >
                  End the stage
                </GlassButton>
              </>
            )}
          </div>
          {session.instance && states.length > 0 && (
            <ul className="glass-stage-panel__people" aria-label="People on the stage">
              {[...speakers, ...audience].map((person) => (
                <li key={person.user_id} className="glass-stage-panel__person">
                  <span className="glass-stage-panel__name">{nameOf(person)}</span>
                  <span className="glass-stage-panel__role">{person.suppress ? 'Listening' : 'Speaking'}</span>
                  <GlassButton
                    variant="text"
                    aria-disabled={busy || undefined}
                    onClick={() => {
                      if (busy) return;
                      if (person.suppress) session.inviteSpeaker(person.user_id);
                      else session.moveToAudience(person.user_id);
                    }}
                  >
                    {person.suppress ? 'Invite to speak' : 'Move to the audience'}
                  </GlassButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canManage && session.instance && hands.length > 0 && (
        <div className="glass-stage-panel__hands">
          <p className="glass-stage-panel__line">
            <Hand size={14} strokeWidth={1.8} aria-hidden="true" />
            {hands.length === 1 ? 'One person wants to speak' : `${hands.length} people want to speak`}
          </p>
          <ul className="glass-stage-panel__people">
            {hands.map((person) => (
              <li key={person.user_id} className="glass-stage-panel__person">
                <span className="glass-stage-panel__name">{nameOf(person)}</span>
                <GlassButton
                  variant="glass"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) session.inviteSpeaker(person.user_id);
                  }}
                >
                  Let them speak
                </GlassButton>
                <GlassButton
                  variant="text"
                  aria-label={`Dismiss ${nameOf(person)}'s request`}
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) session.dismissRequest(person.user_id);
                  }}
                >
                  Dismiss
                </GlassButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      {session.error && (
        <p role="alert" className="glass-stage-panel__error">
          {session.error}
        </p>
      )}
    </section>
  );
}
