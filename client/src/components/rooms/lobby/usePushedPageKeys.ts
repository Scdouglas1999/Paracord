import { useEffect } from 'react';

import { useGlassStore } from '../../../stores/glassStore';

/**
 * Esc and Alt+Left go back on a pushed page (docs/index-spec.md §6.1: a thread, a
 * sports game, a forum post), as the toolbar's back chevron does.
 *
 * Esc yields to anything else that Esc closes first: a typing field (it is how you
 * leave one), an open dialog or menu, a sheet, the call view. Alt+Left is the
 * browser's own back; here it is the page's, and it works from anywhere that is not
 * a text field.
 */
export function usePushedPageKeys(onBack: (() => void) | null): void {
  useEffect(() => {
    if (!onBack) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.shiftKey;
      const escape = event.key === 'Escape' && !event.altKey && plain;
      const altLeft = event.key === 'ArrowLeft' && event.altKey && plain;
      if (!escape && !altLeft) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (escape) {
        const glass = useGlassStore.getState();
        if (glass.sheet !== null || glass.stage.mode !== 'none') return;
        if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      }
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);
}
