/**
 * Needs-you attention scoring (layout-spec §3.3).
 *
 * Pure function — NO store or React imports. Pinned entries are pulled out by
 * the caller BEFORE scoring; they never compete for the Needs-you cap.
 *
 * Weight table (exact, §3.3):
 *   direct/role mention  1000 * min(mentionCount, 9)   (top tier)
 *   DM unread            400
 *   thread reply         120
 *   plain unread         40
 *   voice activity       30
 *   recency boost        + 60 * exp(-ageHours/12)       (tie-shaper only)
 *
 * The recency term is a TIE-SHAPER: its max value (60, at age 0) is strictly
 * below the smallest tier gap (voice 30 → plain unread 40 differ by only 10,
 * but recency applies uniformly and can never lift a scored entry above the
 * next signal tier because the tier weights dominate at 120/400/1000). The
 * invariant "recency never overtakes a higher tier" is asserted in tests.
 */

import type { ConversationEntry } from './conversationModel';
import { snowflakeToMs } from './conversationModel';

const MENTION_WEIGHT = 1000;
const MENTION_CLAMP = 9;
const DM_UNREAD_WEIGHT = 400;
const THREAD_REPLY_WEIGHT = 120;
const PLAIN_UNREAD_WEIGHT = 40;
const VOICE_ACTIVITY_WEIGHT = 30;
const RECENCY_WEIGHT = 60;
const RECENCY_HALFLIFE_HOURS = 12;

export function scoreEntry(e: ConversationEntry, nowMs: number): number {
  let score = 0;

  if (e.mentionCount > 0) {
    score += MENTION_WEIGHT * Math.min(e.mentionCount, MENTION_CLAMP);
  }
  if (e.isDMUnread) {
    score += DM_UNREAD_WEIGHT;
  }
  if (e.isThreadReply) {
    score += THREAD_REPLY_WEIGHT;
  }
  if (e.unread) {
    score += PLAIN_UNREAD_WEIGHT;
  }
  if (e.hasVoiceActivity) {
    score += VOICE_ACTIVITY_WEIGHT;
  }

  // Recency boost — tie-shaper only. Skipped when there is no activity id.
  if (e.lastActivityId != null) {
    const ageHours = (nowMs - snowflakeToMs(e.lastActivityId)) / 3_600_000;
    if (ageHours >= 0) {
      score += RECENCY_WEIGHT * Math.exp(-ageHours / RECENCY_HALFLIFE_HOURS);
    }
  }

  return score;
}
