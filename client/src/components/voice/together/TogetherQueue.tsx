import { useState } from 'react';
import { GripVertical, Plus, X } from 'lucide-react';

import type { TogetherApi } from '../../../api/together';
import { canControl, type TogetherSession } from '../../../lib/together/model';
import { cn } from '../../../lib/utils';
import { Button, IconButton } from '../../ui';
import { runTogether } from './TogetherControls';
import { TogetherCover } from './TogetherCover';

export interface TogetherQueueProps {
  session: TogetherSession;
  api: TogetherApi;
  selfUserId: string | null;
  nameOf: (userId: string) => string;
  onAdd: () => void;
  className?: string;
}

/**
 * The queue: what plays now and next. Drag a row (or focus it and press
 * Alt+↑/↓) to reorder, click one to play it now, × to take it out.
 */
export function TogetherQueue({ session, api, selfUserId, nameOf, onAdd, className }: TogetherQueueProps) {
  const allowed = canControl(session, selfUserId);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const channelId = session.channel_id;

  const move = (itemId: string, index: number) =>
    void runTogether(() => api.moveItem(channelId, itemId, Math.max(0, Math.min(session.items.length - 1, index))));

  return (
    <section aria-label="Queue" className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-label font-semibold text-text-primary">
          Queue <span className="font-normal text-text-muted">{session.items.length}</span>
        </h3>
        <Button variant="ghost" size="sm" onClick={onAdd} disabled={!allowed}>
          <Plus size={14} aria-hidden />
          Add
        </Button>
      </div>
      <ol className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-0.5" onDragLeave={() => setOver(null)}>
        {session.items.map((item, index) => {
          const current = index === session.current_index;
          return (
            <li
              key={item.id}
              draggable={allowed}
              tabIndex={0}
              aria-current={current ? 'true' : undefined}
              aria-label={`${item.title}${current ? ', playing now' : ''}`}
              onDragStart={(event) => {
                setDragging(item.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                setOver(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = dragging ?? event.dataTransfer.getData('text/plain');
                setDragging(null);
                setOver(null);
                const from = session.items.findIndex((entry) => entry.id === id);
                if (id && from !== -1 && from !== index) move(id, index);
              }}
              onKeyDown={(event) => {
                if (!allowed || !event.altKey) return;
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  move(item.id, index - 1);
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  move(item.id, index + 1);
                }
              }}
              className={cn(
                'pc-focusable group flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] py-1.5 pl-1 pr-1.5',
                'transition-[background-color,opacity] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                current ? 'bg-bg-mod-strong' : 'hover:bg-bg-mod-subtle',
                dragging === item.id && 'opacity-50',
                over === index && dragging !== item.id && 'shadow-[inset_0_2px_0_0_var(--border-strong)]',
              )}
            >
              <GripVertical
                size={14}
                aria-hidden
                className={cn('shrink-0 text-text-faint', allowed ? 'cursor-grab' : 'invisible')}
              />
              <button
                type="button"
                disabled={!allowed || current}
                onClick={() => void runTogether(() => api.playback(channelId, { action: 'skip', item_id: item.id }))}
                className="pc-focusable flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-control)] text-left disabled:cursor-default"
                aria-label={current ? `${item.title} is playing` : `Play ${item.title} now`}
              >
                <span className="h-9 w-16 shrink-0 overflow-hidden rounded-[6px] bg-bg-well">
                  <TogetherCover item={item} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn('truncate text-label', current ? 'font-semibold text-text-primary' : 'text-text-secondary')}>
                    {item.title}
                  </span>
                  <span className="truncate text-meta text-text-muted">
                    {current ? (session.playing ? 'Playing now' : 'Paused') : `Added by ${nameOf(item.added_by)}`}
                  </span>
                </span>
              </button>
              {allowed && (
                <IconButton
                  label={`Remove ${item.title}`}
                  size="sm"
                  tone="ghost"
                  onClick={() => void runTogether(() => api.removeItem(channelId, item.id))}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                >
                  <X size={14} />
                </IconButton>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
