/**
 * What the live preview shows (docs/setup-spec.md §1.9). A static model, not
 * the live stores, so typing costs nothing beyond this component.
 *
 * - Host: the server exactly as the claim creates it (§2.7): `general`,
 *   `clips`, `plans` with their topics, voice channels `Lounge` and `Gaming`,
 *   and the welcome with its three first steps. The status line follows setup
 *   row 1.
 * - Join: the server's name, hue and online count from the invite preview. Its
 *   channels and messages are placeholder shapes: the invite preview does not
 *   and must not reveal them to someone who is not a member yet (§1.9, the one
 *   deliberate difference from the prototype).
 */

export type PreviewStatus = 'off' | 'starting' | 'online';

export interface HostPreviewModel {
  kind: 'host';
  name: string;
  hue: number;
  status: PreviewStatus;
  me: string | null;
}

export interface JoinPreviewModel {
  kind: 'join';
  /** Null until an invite resolves: the preview is dimmed and desaturated. */
  server: { name: string; hue: number; online: number | null; members: number | null } | null;
  me: string | null;
}

export type PreviewModel = HostPreviewModel | JoinPreviewModel;

export const HOST_TEXT_CHANNELS = [
  { name: 'general', topic: 'Say hi to everyone' },
  { name: 'clips', topic: 'Share highlights and screenshots' },
  { name: 'plans', topic: "What's happening this week" },
] as const;

export const HOST_VOICE_CHANNELS = ['Lounge', 'Gaming'] as const;

export const HOST_FIRST_STEPS = [
  { glyph: 'link', title: 'Invite friends', line: 'Share your link or QR code.' },
  { glyph: 'speaker', title: 'Hop in Lounge', line: "Friends see you're there and can join." },
  { glyph: 'globe', title: 'Make it yours', line: 'Add an icon, channels and roles.' },
] as const;

export function hostStatusLine(status: PreviewStatus): string {
  if (status === 'online') return 'Online · just you';
  if (status === 'starting') return 'Starting…';
  return 'Not running yet';
}

/** The first letter, uppercase ("?" while there is no name). */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0].toUpperCase();
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
