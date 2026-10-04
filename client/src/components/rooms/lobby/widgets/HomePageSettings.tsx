import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { GripVertical } from 'lucide-react';

import { Switch } from '../../../ui';
import { cn } from '../../../../lib/utils';
import {
  HOME_WIDGET_HINTS,
  HOME_WIDGET_LABELS,
  moveWidget,
  type HomeWidgetId,
  type HomeWidgetSetting,
} from './widgetConfig';

export interface HomePageSettingsProps {
  widgets: readonly HomeWidgetSetting[];
  onChange: (next: HomeWidgetSetting[]) => void;
}

/**
 * "Overview" in Server settings → Server hub: which widgets sit under the title
 * on the server's Overview, above the latest posts, and in what order. Drag a
 * row by its handle, or focus the handle and use the arrow keys. The preview
 * beside the list is the page as it will lay out: the widgets in two columns
 * (one in a narrow window), the latest posts below.
 */
export function HomePageSettings({ widgets, onChange }: HomePageSettingsProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const handles = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= widgets.length || from === to) return;
    onChange(moveWidget(widgets, from, to));
    setAnnouncement(`${HOME_WIDGET_LABELS[widgets[from].id]} moved to position ${to + 1} of ${widgets.length}.`);
  };

  const toggle = (id: HomeWidgetId, enabled: boolean) =>
    onChange(widgets.map((widget) => (widget.id === id ? { ...widget, enabled } : widget)));

  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
    if (to === null || to < 0 || to >= widgets.length) return;
    event.preventDefault();
    move(index, to);
    // Keep the keyboard on the row that moved.
    requestAnimationFrame(() => handles.current[to]?.focus());
  };

  const onDrop = (event: DragEvent<HTMLLIElement>, index: number) => {
    event.preventDefault();
    if (dragging !== null) move(dragging, index);
    setDragging(null);
    setOver(null);
  };

  const shown = widgets.filter((widget) => widget.enabled);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
      <ol aria-label="Home page widgets" className="flex flex-col gap-1.5">
        {widgets.map((widget, index) => {
          const label = HOME_WIDGET_LABELS[widget.id];
          return (
            <li
              key={widget.id}
              onDragOver={(event) => {
                event.preventDefault();
                if (over !== index) setOver(index);
              }}
              onDragLeave={() => setOver((current) => (current === index ? null : current))}
              onDrop={(event) => onDrop(event, index)}
              className={cn(
                'flex items-center gap-3 rounded-[var(--r-row)] bg-[var(--bub)] py-2.5 pl-1.5 pr-3',
                'shadow-[var(--sh-content)] transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                dragging === index && 'opacity-50',
                // Where the row will land: a line above it, in ink (not a color).
                over === index && dragging !== null && dragging !== index && 'shadow-[0_-2px_0_0_var(--ink-1)]',
              )}
            >
              <button
                ref={(node) => {
                  handles.current[index] = node;
                }}
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', widget.id);
                  setDragging(index);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onKeyDown={(event) => onHandleKey(event, index)}
                aria-label={`Move ${label}. Position ${index + 1} of ${widgets.length}. Use the up and down arrows.`}
                className="pc-focusable flex h-8 w-7 shrink-0 cursor-grab items-center justify-center rounded-[var(--r-chip)] text-[var(--ink-3)] hover:bg-[var(--wash-hover)] hover:text-[var(--ink-1)] active:cursor-grabbing"
              >
                <GripVertical size={16} aria-hidden />
              </button>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span id={`home-widget-${widget.id}`} className="glass-name">
                  {label}
                </span>
                <span className="glass-secondary">{HOME_WIDGET_HINTS[widget.id]}</span>
              </span>
              <Switch
                checked={widget.enabled}
                onChange={(next) => toggle(widget.id, next)}
                labeledBy={`home-widget-${widget.id}`}
              />
            </li>
          );
        })}
      </ol>

      <figure aria-label="Preview" className="flex flex-col gap-2">
        <figcaption className="glass-kicker text-[var(--ink-3)]">Preview</figcaption>
        <div aria-hidden className="flex flex-col gap-1.5 overflow-hidden rounded-[var(--r-bubble)] bg-[var(--solid)] p-2.5">
          <div className="h-8 rounded-[var(--r-chip)] bg-[var(--glass-fill-quiet)]" />
          <span className="h-4 rounded-[var(--r-chip)] bg-[var(--glass-fill-quiet)]" />
          {shown.length === 0 && <span className="pt-1 text-[11px] leading-tight text-[var(--ink-3)]">No widgets</span>}
          <div data-testid="widget-preview-grid" className="grid grid-cols-2 gap-1.5">
            {shown.map((widget) => (
              <span
                key={widget.id}
                className="flex h-9 items-start rounded-[var(--r-chip)] bg-[var(--bub)] px-2 pt-1.5 text-[11px] font-medium leading-tight text-[var(--ink-2)]"
              >
                {HOME_WIDGET_LABELS[widget.id]}
              </span>
            ))}
          </div>
          {[0, 1].map((row) => (
            <span key={row} className="h-10 rounded-[var(--r-chip)] bg-[var(--glass-fill-quiet)]" />
          ))}
        </div>
        <p className="glass-secondary">
          The widgets sit in two columns under the title, one in a narrow window, with the latest posts below them.
        </p>
      </figure>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
