import type { HubSettings } from '../../../../types';

/**
 * Which widgets a server's home page shows, and in what order
 * (docs/server-home-spec.md, "Widget column").
 *
 * Stored as `hub_settings.widgets = [{ id, enabled }]`. The server refuses an
 * unknown id or a repeated one (`routes/guilds.rs`), so what comes back is
 * already clean; this still reads it defensively, because a server running an
 * older build may hand back a hub with no list at all.
 */

export const HOME_WIDGET_IDS = [
  'coming_up',
  'media',
  'most_active',
  'game',
  'pinned',
  'new_here',
  'daily_word',
  'game_servers',
] as const;

export type HomeWidgetId = (typeof HOME_WIDGET_IDS)[number];

export interface HomeWidgetSetting {
  id: HomeWidgetId;
  enabled: boolean;
}

/** What each widget is called, in settings and on the page. */
export const HOME_WIDGET_LABELS: Record<HomeWidgetId, string> = {
  coming_up: 'Coming up',
  media: 'Media',
  most_active: 'Most active',
  game: 'Game',
  pinned: 'Pinned',
  new_here: 'New here',
  daily_word: 'Daily word',
  game_servers: 'Game servers',
};

/** One line under each toggle in settings: when it shows, and what it holds. */
export const HOME_WIDGET_HINTS: Record<HomeWidgetId, string> = {
  coming_up: 'The next three events, with RSVP on the first.',
  media: 'The latest six pictures. Hidden until someone posts one.',
  most_active: 'The top four by XP among people active this week.',
  game: 'A live or upcoming game for the teams you follow. Needs Sports.',
  pinned: 'The latest pin in an announcement channel.',
  new_here: 'People who joined in the last 14 days.',
  daily_word: "Who solved today's word, and your own result. Needs Daily word.",
  game_servers: "Whether each game server is up, and who's on. Needs Game servers.",
};

/** A server that never configured its home page gets every widget, in this order. */
export const DEFAULT_HOME_WIDGETS: readonly HomeWidgetSetting[] = HOME_WIDGET_IDS.map((id) => ({
  id,
  enabled: true,
}));

function isWidgetId(value: unknown): value is HomeWidgetId {
  return typeof value === 'string' && (HOME_WIDGET_IDS as readonly string[]).includes(value);
}

/**
 * The saved list, completed: every known widget exactly once, the saved ones
 * first in their saved order, and any widget this build knows but the list
 * does not (added after the owner last saved) appended, switched on.
 */
export function readHomeWidgets(settings: HubSettings | null | undefined): HomeWidgetSetting[] {
  const raw = settings?.widgets;
  if (!Array.isArray(raw)) return DEFAULT_HOME_WIDGETS.map((widget) => ({ ...widget }));
  const seen = new Set<HomeWidgetId>();
  const out: HomeWidgetSetting[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, enabled } = entry as { id?: unknown; enabled?: unknown };
    if (!isWidgetId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, enabled: enabled !== false });
  }
  for (const id of HOME_WIDGET_IDS) {
    if (!seen.has(id)) out.push({ id, enabled: true });
  }
  return out;
}

/** Widgets that belong to an add-on, and whether that add-on is on here. */
export interface AddonWidgetsOn {
  daily_word: boolean;
  game_servers: boolean;
}

/**
 * The list the home page settings show and save. An add-on's widget is left
 * out while the add-on is off on this server, unless the saved list already
 * names it: a server from before the add-on refuses a widget id it does not
 * know, so a list that never had it must not gain it there.
 */
export function listedWidgets(
  list: readonly HomeWidgetSetting[],
  settings: HubSettings | null | undefined,
  addonsOn: AddonWidgetsOn,
): HomeWidgetSetting[] {
  const saved = (id: HomeWidgetId) =>
    Array.isArray(settings?.widgets)
    && settings.widgets.some((entry) => (entry as { id?: unknown } | null)?.id === id);
  return list.filter((widget) => {
    if (widget.id === 'daily_word' || widget.id === 'game_servers') {
      return addonsOn[widget.id] || saved(widget.id);
    }
    return true;
  });
}

/** The enabled widgets, in order. */
export function enabledWidgets(settings: HubSettings | null | undefined): HomeWidgetId[] {
  return readHomeWidgets(settings)
    .filter((widget) => widget.enabled)
    .map((widget) => widget.id);
}

/** Move one entry from `from` to `to`, for drag and for the keyboard arrows. */
export function moveWidget(
  list: readonly HomeWidgetSetting[],
  from: number,
  to: number,
): HomeWidgetSetting[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
