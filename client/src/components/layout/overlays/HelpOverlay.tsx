import { useRef } from 'react';
import type { RefObject } from 'react';
import { Keyboard } from 'lucide-react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { formatShortcutKey } from '../../../lib/keyboardShortcuts';
import { TopBarOverlay } from './TopBarOverlay';

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  label: string;
  keys: string[];
}

const SHORTCUT_GROUPS: Array<{ title: string; shortcuts: Shortcut[] }> = [
  {
    title: 'Navigation',
    shortcuts: [
      { label: 'Command palette', keys: ['Mod', 'K'] },
      { label: 'Search in channel', keys: ['Mod', 'F'] },
      { label: 'Switch guild', keys: ['Ctrl', 'Alt', '↑/↓'] },
    ],
  },
  {
    title: 'Settings',
    shortcuts: [
      { label: 'User settings', keys: ['Ctrl', ','] },
      { label: 'Guild settings', keys: ['Ctrl', 'Shift', ','] },
    ],
  },
  {
    title: 'Messaging',
    shortcuts: [
      { label: 'Send message', keys: ['Enter'] },
      { label: 'New line', keys: ['Shift', 'Enter'] },
    ],
  },
  {
    title: 'General',
    shortcuts: [{ label: 'Close modal', keys: ['Esc'] }],
  },
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
      title="Keyboard Shortcuts"
      icon={Keyboard}
      closeLabel="Close keyboard shortcuts"
      panelClassName="max-h-[min(82dvh,34rem)] w-full max-w-2xl"
      bodyClassName="px-5 py-5"
    >
      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2.5 text-section uppercase text-text-muted">{group.title}</h3>
            <dl className="space-y-2">
              {group.shortcuts.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-4">
                  <dt className="text-label text-text-secondary">{item.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {item.keys.map((k) => (
                      <kbd
                        key={k}
                        className="inline-flex min-w-[1.75rem] items-center justify-center rounded-xs bg-bg-mod-strong px-1.5 py-1 font-code text-meta font-semibold text-text-secondary"
                      >
                        {formatShortcutKey(k)}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </TopBarOverlay>
  );
}
