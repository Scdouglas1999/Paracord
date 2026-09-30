/**
 * A posted clip is an ordinary attachment. What makes it a clip is its file
 * name, which says what it is to anyone who downloads it and lets every client
 * draw it as a clip ("0:30 from Vincent's screen") with nothing added to the
 * message or the server:
 *
 *   Clip 0m30s from Vincent's screen.webm
 *
 * In an encrypted conversation the name travels inside the encrypted message
 * body, like every other attachment name there.
 */

const CLIP_NAME = /^Clip (\d{1,3})m([0-5]\d)s from (.+)\.(webm|mp4)$/;
/** Characters that do not belong in a file name on some system, and control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_SOURCE_LENGTH = 80;

/** Whole seconds a clip lasts, as the label shows it (rounded, at least 1). */
export function clipSeconds(durationMs: number): number {
  return Math.max(1, Math.round(durationMs / 1000));
}

/** "0:30", "1:05". */
export function formatClipDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "Vincent's screen" for "Vincent". */
export function screenSourceName(streamerName: string): string {
  const name = streamerName.trim() || 'Someone';
  return /s$/i.test(name) ? `${name}' screen` : `${name}'s screen`;
}

export function clipFilename(durationMs: number, sourceName: string, extension: 'webm' | 'mp4'): string {
  const seconds = clipSeconds(durationMs);
  const source = sourceName.replace(UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_LENGTH) || 'a stream';
  return `Clip ${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s from ${source}.${extension}`;
}

export interface ClipFileInfo {
  seconds: number;
  source: string;
  /** "0:30 from Vincent's screen". */
  label: string;
}

/** What a clip's file name says, or null for any other file. */
export function parseClipFilename(filename: string): ClipFileInfo | null {
  const match = CLIP_NAME.exec(filename);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  if (seconds <= 0) return null;
  const source = match[3];
  return { seconds, source, label: `${formatClipDuration(seconds)} from ${source}` };
}
