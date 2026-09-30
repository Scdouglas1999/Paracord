import { AlertTriangle } from 'lucide-react';
import { useVoiceStore } from '../../../stores/voiceStore';
import { CallPill } from '../pill';
import { useGlassLayout } from '../shell/useGlassLayout';
import type { ConversationPaneProps } from '../shell/slots';
import { ConversationHeader } from './ConversationHeader';

/**
 * The Glass conversation pane (docs/glass-spec.md §3.2, §8; WP-G11): what fills
 * the conversation pane the shell paints. Contract: `ConversationPaneProps` in
 * `components/glass/shell/slots.ts`.
 *
 *   header      76px: the title at the column's left edge, the call pill's slot
 *               at its right edge, search / members / your face at the pane's
 *               right edge. On a phone the pill sits above it, in two rows.
 *   notices     strips between the header and the timeline, in the column
 *   timeline    full pane width, its rows sit in the column (WP-G10)
 *   composer    the message box, a 52px capsule (styles/glass-conversation.css)
 *   dock        a DM call's control bar, until the pill carries it (WP-G12)
 *
 * The shell sizes and paints the pane; this fills it and never sets its own
 * outer size, radius or position. Region class names are the shell's contract
 * (`.glass-conversation__*`, styles/glass-layout.css).
 */
export function ConversationPane({ subject, notices, timeline, composer, dock }: ConversationPaneProps) {
  const layout = useGlassLayout();
  const capturing = useVoiceStore((s) => s.systemAudioCaptureActive);

  return (
    <div className="glass-conversation" data-subject={subject.kind} data-layout={layout}>
      {layout === 'phone' && (
        <div className="glass-conversation__phone-pill">
          <CallPill guildId={subject.kind === 'channel' ? subject.guildId : null} layout="stacked" />
        </div>
      )}
      <div className="glass-conversation__header">
        <ConversationHeader subject={subject} />
      </div>
      {capturing && (
        // Privacy, not decoration: everyone in the call can hear this device.
        <div role="status" aria-label="System audio capture is active" className="glass-conversation__capture">
          <AlertTriangle size={16} aria-hidden className="shrink-0" />
          <span>System audio capture is active</span>
        </div>
      )}
      {notices != null && <div className="glass-conversation__notices">{notices}</div>}
      <div className="glass-conversation__timeline">{timeline}</div>
      {composer != null && <div className="glass-conversation__composer">{composer}</div>}
      {dock}
    </div>
  );
}
