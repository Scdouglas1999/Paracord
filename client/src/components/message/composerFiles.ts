/**
 * Files dropped somewhere other than the message box (docs/index-spec.md §4.12:
 * "Drag and drop over main shows a full-main drop target"; IX-15 draws that
 * target). The box registers itself for its conversation while it is mounted;
 * the drop target hands it the files with `stageComposerFiles`, and they queue
 * in the box exactly as if they had been attached there (same permission
 * checks, same refusals).
 */

type Stage = (files: File[]) => void;

const boxes = new Map<string, Stage>();

/** Called by the message box for its conversation. Returns the unregister. */
export function registerComposerFiles(channelId: string, stage: Stage): () => void {
  boxes.set(channelId, stage);
  return () => {
    if (boxes.get(channelId) === stage) boxes.delete(channelId);
  };
}

/**
 * Queue files in the conversation's message box. False when no box is open for
 * it (the caller says so; nothing is dropped silently).
 */
export function stageComposerFiles(channelId: string, files: File[]): boolean {
  const stage = boxes.get(channelId);
  if (!stage) return false;
  stage(files);
  return true;
}
