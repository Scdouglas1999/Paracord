/**
 * Index accessibility pieces that are not one component's (docs/index-spec.md §10).
 *
 *   IxAnnouncer ... the one polite live region, mounted by the frame, and what
 *                   feeds it from the call world
 *   announce ...... say something in it (paced to one announcement every 2s)
 */
export { IxAnnouncer } from './IxAnnouncer';
export { ANNOUNCE_GAP_MS, announce, resetAnnouncer, useAnnouncerStore } from './announcer';
export { announcementsBetween, voiceSnapshot } from './announcements';
export type { AnnouncementContext, PersonInRoom, VoiceSnapshot } from './announcements';
