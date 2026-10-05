import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { toast } from '../../../stores/toastStore';
import { stageComposerFiles } from '../../message/composerFiles';

/** Files dragged in from the desktop, as opposed to text or a link dragged around the page. */
export function dragHasFiles(transfer: DataTransfer | null | undefined): boolean {
  return Boolean(transfer && Array.from(transfer.types ?? []).includes('Files'));
}

export interface DropTargetProps {
  /** The conversation's root: where the message box (the drop's destination) is. */
  root: RefObject<HTMLElement | null>;
  channelId: string;
  /** "general", "Jeremy": the words after "Drop to share in". */
  name: string;
}

/**
 * The full-main drop target (docs/index-spec.md §4.12): dragging files over main
 * dims it to `rgba(14,15,17,.9)` with a dashed `--ix-line` 2px outline at inset 10,
 * radius 24, saying "Drop to share in general". A drop anywhere in main hands the
 * files to the message box (`stageComposerFiles`: they queue exactly as if attached
 * there, with the same checks and the same refusals). A drop ON the box is the
 * box's own (its open ring is its drag-over state), so the target steps aside while
 * the pointer is over it.
 *
 * Main is where the listeners live (the toolbar is part of main), and the overlay
 * is drawn in main, over everything but the sheets; it never takes the pointer, so
 * the events still land on what is under it. It appears only where there is a box
 * to receive files (not in a read-only channel, a locked conversation, or a person
 * without Attach Files); then a drop is left alone for the page to ignore. Nothing
 * a drop cannot do is promised, and a drop that finds no box says so out loud.
 */
export function DropTarget({ root, channelId, name }: DropTargetProps) {
  // Main, while files are over it (the overlay is drawn there); null otherwise.
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const depth = useRef(0);

  useEffect(() => {
    const main = root.current?.closest<HTMLElement>('.ix-main') ?? root.current;
    if (!main) return;
    const setActive = (on: boolean) => setTarget(on ? main : null);
    const composer = () => root.current?.querySelector<HTMLElement>('[data-testid="ix-composer"]') ?? null;
    /** There is a box that will take files for this conversation. */
    const receiving = () => {
      const box = composer();
      return Boolean(box && !box.hasAttribute('data-read-only') && box.querySelector('[data-composer-input]'));
    };
    const overBox = (target: EventTarget | null) => target instanceof Node && Boolean(composer()?.contains(target));

    const reset = () => {
      depth.current = 0;
      setActive(false);
    };
    const onEnter = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer) || !receiving()) return;
      depth.current += 1;
      setActive(!overBox(event.target));
    };
    const onOver = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer) || !receiving()) return;
      const inBox = overBox(event.target);
      setActive(!inBox);
      if (inBox) return; // the box accepts it itself
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (event: DragEvent) => {
      const wasActive = depth.current > 0;
      reset();
      if (!wasActive || !dragHasFiles(event.dataTransfer) || overBox(event.target)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      if (!stageComposerFiles(channelId, files)) toast.error('There is no message box open here to take these files.');
    };

    main.addEventListener('dragenter', onEnter);
    main.addEventListener('dragover', onOver);
    main.addEventListener('dragleave', onLeave);
    main.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    return () => {
      main.removeEventListener('dragenter', onEnter);
      main.removeEventListener('dragover', onOver);
      main.removeEventListener('dragleave', onLeave);
      main.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
    };
  }, [root, channelId]);

  if (!target) return null;
  return createPortal(
    <div className="ix-drop" data-testid="ix-drop-target" role="presentation" aria-hidden>
      <div className="ix-drop__box">
        <span className="ix-drop__label">Drop to share in {name}</span>
      </div>
    </div>,
    target,
  );
}
