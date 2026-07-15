import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof window === 'undefined') return true;
    const styles = window.getComputedStyle(el);
    return styles.display !== 'none' && styles.visibility !== 'hidden';
  });
}

/**
 * Traps keyboard focus within an active dialog/panel and restores focus on close.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onClose?: () => void
) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = getFocusableElements(container);
    (focusables[0] ?? container).focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        // Stop other shell Escape handlers (TopBar, keyboard nav) from also
        // collapsing a lower layer on the same keypress.
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      const currentFocusable = getFocusableElements(container);
      if (currentFocusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }

      const first = currentFocusable[0];
      const last = currentFocusable[currentFocusable.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;
      const isInside = activeElement ? container.contains(activeElement) : false;

      if (e.shiftKey) {
        if (!isInside || activeElement === first) {
          e.preventDefault();
          last.focus();
        }
        return;
      }

      if (!isInside || activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previousActive && document.contains(previousActive)) {
        previousActive.focus();
      }
    };
  }, [active, containerRef, onClose]);
}
