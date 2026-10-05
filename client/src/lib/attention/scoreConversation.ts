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
 *   recency boost        + 8 * exp(-ageHours/12)        (tie-shaper only)
 *
 * The recency term is a strict TIE-SHAPER. The smallest adjacent-tier gap is
 * voice(30) → plain-unread(40) = 10, so the boost ceiling is pinned BELOW that
 * gap (max 8, at age 0). This makes the invariant real: a freshly-active
 * voice-only room (30 + 8 = 38) can never overtake a stale plain-unread channel
 * (40 + ~0), so a burst of empty-but-just-occupied voice rooms can no longer
 * evict channels holding actual unread messages from the capped Needs-you
 * shortlist. Within a tier the boost still orders fresher entries first. (The
 * earlier value 60 contradicted this invariant — voice+60 = 90 outranked plain
 * unread 40 — so it is corrected here to the sub-gap ceiling the spec prose and
 * this docstring both promise; the invariant is asserted in tests.)
 */

import type { ConversationEntry } from './conversationModel';
import { snowflakeToMs } from './conversationModel';

const MENTION_WEIGHT = 1000;
const MENTION_CLAMP = 9;
const DM_UNREAD_WEIGHT = 400;
const THREAD_REPLY_WEIGHT = 120;
const PLAIN_UNREAD_WEIGHT = 40;
const VOICE_ACTIVITY_WEIGHT = 30;
const RECENCY_WEIGHT = 8;
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
