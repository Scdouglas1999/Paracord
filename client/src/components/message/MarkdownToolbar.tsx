import { Bold, Italic, Strikethrough, Code, Quote, Link, Eye, FileCode2 } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';

interface MarkdownToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onContentChange: (content: string) => void;
}

interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function wrapSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
  onContentChange: (content: string) => void,
) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selected = text.slice(start, end);

  const newText = text.slice(0, start) + before + selected + after + text.slice(end);
  // Use native setter to trigger React's onChange
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, newText);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  onContentChange(newText);

  // Restore cursor position: select the text between the markers
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(start + before.length, end + before.length);
  });
}

function prefixLine(
  textarea: HTMLTextAreaElement,
  prefix: string,
  onContentChange: (content: string) => void,
) {
  const start = textarea.selectionStart;
  const text = textarea.value;

  // Find the start of the current line
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newText = text.slice(0, lineStart) + prefix + text.slice(lineStart);

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, newText);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  onContentChange(newText);

  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(start + prefix.length, start + prefix.length);
  });
}

export type MarkdownToolbarActionId =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'inline_code'
  | 'code_block'
  | 'spoiler'
  | 'link'
  | 'quote';

interface ToolbarButton {
  id: MarkdownToolbarActionId;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  shortcutKey?: string;
  shortcutShift?: boolean;
  action: (textarea: HTMLTextAreaElement, onContentChange: (c: string) => void) => void;
}

const TOOLBAR_BUTTONS: ToolbarButton[] = [
  {
    id: 'bold',
    icon: <Bold size={14} />,
    label: 'Bold',
    shortcut: 'Ctrl+B',
    shortcutKey: 'b',
    action: (ta, cb) => wrapSelection(ta, '**', '**', cb),
  },
  {
    id: 'italic',
    icon: <Italic size={14} />,
    label: 'Italic',
    shortcut: 'Ctrl+I',
    shortcutKey: 'i',
    action: (ta, cb) => wrapSelection(ta, '*', '*', cb),
  },
  {
    id: 'strikethrough',
    icon: <Strikethrough size={14} />,
    label: 'Strikethrough',
    shortcut: 'Ctrl+Shift+X',
    shortcutKey: 'x',
    shortcutShift: true,
    action: (ta, cb) => wrapSelection(ta, '~~', '~~', cb),
  },
  {
    id: 'inline_code',
    icon: <Code size={14} />,
    label: 'Inline Code',
    shortcut: 'Ctrl+`',
    shortcutKey: '`',
    action: (ta, cb) => wrapSelection(ta, '`', '`', cb),
  },
  {
    id: 'code_block',
    icon: <FileCode2 size={14} />,
    label: 'Code Block',
    shortcut: 'Ctrl+Shift+`',
    shortcutKey: '`',
    shortcutShift: true,
    action: (ta, cb) => wrapSelection(ta, '```\n', '\n```', cb),
  },
  {
    id: 'spoiler',
    icon: <Eye size={14} />,
    label: 'Spoiler',
    action: (ta, cb) => wrapSelection(ta, '||', '||', cb),
  },
  {
    id: 'link',
    icon: <Link size={14} />,
    label: 'Link',
    shortcut: 'Ctrl+K',
    shortcutKey: 'k',
    action: (ta, cb) => {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = ta.value.slice(start, end);
      if (selected) {
        wrapSelection(ta, '[', '](url)', cb);
      } else {
        wrapSelection(ta, '[text](', ')', cb);
      }
    },
  },
  {
    id: 'quote',
    icon: <Quote size={14} />,
    label: 'Block Quote',
    shortcut: 'Ctrl+Shift+Q',
    shortcutKey: 'q',
    shortcutShift: true,
    action: (ta, cb) => prefixLine(ta, '> ', cb),
  },
];

export function applyMarkdownToolbarAction(
  actionId: MarkdownToolbarActionId,
  textarea: HTMLTextAreaElement,
  onContentChange: (content: string) => void,
): boolean {
  const button = TOOLBAR_BUTTONS.find((entry) => entry.id === actionId);
  if (!button) return false;
  button.action(textarea, onContentChange);
  return true;
}

export function resolveMarkdownShortcut(event: ShortcutEventLike): MarkdownToolbarActionId | null {
  if (event.altKey) return null;
  if (!event.ctrlKey && !event.metaKey) return null;
  const key = event.key.toLowerCase();
  const matched = TOOLBAR_BUTTONS.find((button) => {
    if (!button.shortcutKey) return false;
    if (button.shortcutKey.toLowerCase() !== key) return false;
    return Boolean(button.shortcutShift) === event.shiftKey;
  });
  return matched?.id ?? null;
}

export function MarkdownToolbar({ textareaRef, onContentChange }: MarkdownToolbarProps) {
  const handleClick = (button: ToolbarButton) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    applyMarkdownToolbarAction(button.id, textarea, onContentChange);
  };

  return (
    <div className="flex items-center gap-0.5 px-1 py-1">
      {TOOLBAR_BUTTONS.map((button) => (
        <Tooltip
          key={button.label}
          content={button.shortcut ? `${button.label} (${button.shortcut})` : button.label}
        >
          <button
            type="button"
            aria-label={button.shortcut ? `${button.label} (${button.shortcut})` : button.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleClick(button)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors',
              'hover:bg-bg-mod-subtle hover:text-text-primary',
            )}
          >
            {button.icon}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
