import { useRef } from 'react';
import type { RefObject } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { TopBarOverlay } from './TopBarOverlay';

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { label: 'Command Palette', keys: ['Ctrl', 'K'] },
  { label: 'Search in Channel', keys: ['Ctrl', 'F'] },
  { label: 'Switch Guild', keys: ['Ctrl', 'Alt', 'Up/Down'] },
  { label: 'User Settings', keys: ['Ctrl', ','] },
  { label: 'Guild Settings', keys: ['Ctrl', 'Shift', ','] },
  { label: 'Send Message', keys: ['Enter'] },
  { label: 'New Line', keys: ['Shift', 'Enter'] },
  { label: 'Close Modal', keys: ['Esc'] },
];

export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open, onClose);

  return (
    <TopBarOverlay
      open={open}
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-help-title"
      panelClassName="max-h-[min(82dvh,32rem)] w-full max-w-md"
    >
      <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
        <div id="topbar-help-title" className="font-bold text-text-primary">Keyboard Shortcuts</div>
        <button className="command-icon-btn" onClick={onClose} aria-label="Close keyboard shortcuts"><X size={16} /></button>
      </div>
      <div className="space-y-4 p-5">
        {SHORTCUTS.map((item) => (
          <div key={item.label} className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">{item.label}</span>
            <div className="flex gap-1.5">
              {item.keys.map((k) => (
                <kbd key={k} className="min-w-[28px] rounded border border-border-subtle bg-bg-mod-subtle px-2 py-1 text-center font-mono text-sm text-text-muted">{k}</kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
    </TopBarOverlay>
  );
}
