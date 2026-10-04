import { useEffect, useRef, useState } from 'react';

import { pingEdges, type DockEntry, type LiveSnapshot } from './dockModel';

/**
 * Which servers should ping, as a counter per key (§5.5): a server going from
 * not live to live while you are not looking at it pings once. Each edge adds 1
 * to its key; the item plays the ping when its counter moves, so a ping is never
 * replayed by a re-render and never fires on first sight.
 *
 * The edge rule is `pingEdges` (never the current place, never a server that was
 * not in the dock before, never one that was already live).
 */
export function useDockPings(entries: readonly DockEntry[], current: string | null): Record<string, number> {
  const before = useRef<LiveSnapshot | null>(null);
  const [tokens, setTokens] = useState<Record<string, number>>({});

  useEffect(() => {
    const after: LiveSnapshot = {
      live: new Set(entries.filter((entry) => entry.live).map((entry) => entry.key)),
      known: new Set(entries.map((entry) => entry.key)),
    };
    const edges = pingEdges(before.current, after, current);
    before.current = after;
    if (edges.length === 0) return;
    setTokens((previous) => {
      const next = { ...previous };
      for (const key of edges) next[key] = (next[key] ?? 0) + 1;
      return next;
    });
  }, [entries, current]);

  return tokens;
}
