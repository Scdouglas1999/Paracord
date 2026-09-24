import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { File as FileIcon, FileArchive, FileAudio, FileText } from 'lucide-react';

/** Pieces the server-listed and the on-device media panels share. */

export function PlainLine({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'error' }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={tone === 'error'
        ? 'px-4 py-6 text-body text-accent-danger'
        : 'px-4 py-6 text-body text-text-secondary'}
    >
      {children}
    </p>
  );
}

/** "Sep 22": fits under a thumbnail where "less than a minute ago" does not. */
export function shortWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

export function fileIcon(item: { content_type?: string | null; filename: string }) {
  const type = (item.content_type ?? '').toLowerCase();
  const name = item.filename.toLowerCase();
  if (type.startsWith('audio/')) return FileAudio;
  if (type.includes('zip') || type.includes('compressed') || /\.(zip|tar|gz|7z|rar)$/.test(name)) return FileArchive;
  if (type.startsWith('text/') || type === 'application/pdf' || /\.(pdf|txt|md|docx?|rtf)$/.test(name)) return FileText;
  return FileIcon;
}

/** True once the element has come within a screen of the scroll viewport. */
export function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    }, { rootMargin: '300px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}
