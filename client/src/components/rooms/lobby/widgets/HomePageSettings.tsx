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
 * "Home page" in Server settings → Server hub: which widgets sit beside the
 * feed, and in what order. Drag a row by its handle, or focus the handle and
 * use the arrow keys. The preview beside the list is the widget column as it
 * will stack.
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
                'flex items-center gap-3 rounded-[var(--radius-control)] bg-bg-raised py-2.5 pl-1.5 pr-3',
                'shadow-[var(--shadow-raised)] transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                dragging === index && 'opacity-50',
                over === index && dragging !== null && dragging !== index && 'pc-home-drag-over',
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
                className="pc-focusable flex h-8 w-7 shrink-0 cursor-grab items-center justify-center rounded-[var(--radius-chip)] text-text-faint hover:bg-bg-mod-subtle hover:text-text-secondary active:cursor-grabbing"
              >
                <GripVertical size={16} aria-hidden />
              </button>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span id={`home-widget-${widget.id}`} className="text-label text-text-primary">
                  {label}
                </span>
                <span className="text-meta text-text-muted">{HOME_WIDGET_HINTS[widget.id]}</span>
              </span>
              <Switch
                checked={widget.enabled}
                onChange={(next) => toggle(widget.id, next)}
                labelledBy={`home-widget-${widget.id}`}
              />
            </li>
          );
        })}
      </ol>

      <figure aria-label="Preview" className="flex flex-col gap-2">
        <figcaption className="text-section text-text-faint">Preview</figcaption>
        <div aria-hidden className="overflow-hidden rounded-[var(--radius-card)] bg-bg-well shadow-[var(--shadow-well)]">
          <div className="h-8 bg-bg-mod-strong" />
          <div className="grid grid-cols-[minmax(0,1fr)_76px] gap-2 p-2.5">
            <div className="flex flex-col gap-1.5">
              <span className="h-2 w-10 rounded-full bg-bg-mod-strong" />
              {[0, 1, 2].map((row) => (
                <span key={row} className="h-12 rounded-[var(--radius-chip)] bg-bg-mod-subtle" />
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              {shown.length === 0 && <span className="pt-1 text-[10px] leading-tight text-text-faint">No widgets</span>}
              {shown.map((widget) => (
                <span
                  key={widget.id}
                  className="flex h-9 items-start rounded-[var(--radius-chip)] bg-bg-raised px-1.5 pt-1 text-[10px] font-medium leading-tight text-text-secondary shadow-[var(--shadow-raised)]"
                >
                  {HOME_WIDGET_LABELS[widget.id]}
                </span>
              ))}
            </div>
          </div>
        </div>
        <p className="text-meta text-text-muted">
          On a phone, Coming up sits above the feed and the rest follow its fourth post.
        </p>
      </figure>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
