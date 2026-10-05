import type { Page } from '@playwright/test';

/**
 * The motion recorder behind the Index motion gate (`e2e/motion-gate.spec.ts`,
 * docs/index-spec.md §5).
 *
 * The gate needs to know every animation a moment started, not a sample of the
 * ones still running when a frame happened to land. So the recorder is
 * installed before the app loads and hears every animation as it is created:
 *
 *   - Web Animations: `Element.prototype.animate` is wrapped (the Index motion
 *     helpers, the card, the call view, the timeline, the composer all use it);
 *   - CSS transitions and CSS animations: `transitionrun` and `animationstart`
 *     are heard in the capture phase on the window, and the matching
 *     `CSSTransition` / `CSSAnimation` object is taken from the element.
 *
 * Each record keeps the live `Animation`, so the description is read at the
 * end of the moment (a Web Animation's `id` is assigned after `animate()`
 * returns). `describe()` turns them into plain data: what moved, for how long,
 * on which curve, through which keyframes, and whether it was still playing.
 *
 * Nothing here holds a duration of its own: the gate holds each moment to
 * index-spec §5 and names the section it cites.
 */

/** One animation the page started, as plain data. */
export interface MotionRecord {
  /** `web` (Element.animate), `transition` (CSS), `animation` (CSS @keyframes). */
  kind: 'web' | 'transition' | 'animation';
  /** A Web Animation's id (`ix-pane:in`), a transition's property, an @keyframes name. */
  id: string;
  /** Where it ran: `div.ix-pane`, with the element's test id or data-place when it has one. */
  target: string;
  /** The active duration in ms (duration x iterations); null for an infinite loop. */
  duration: number | null;
  delay: number;
  loops: boolean;
  /** The effect's timing easing (a transition's timing function; `linear` for most @keyframes). */
  easing: string;
  /** Each keyframe's own easing, where one is set (an @keyframes rule carries its curve here). */
  keyframeEasings: string[];
  /** Every CSS property a keyframe sets (camelCase, as `getKeyframes` reports them). */
  properties: string[];
  /** Each keyframe's transform, in order. */
  transforms: string[];
  /** Each keyframe's opacity, in order. */
  opacities: string[];
  /** Each keyframe's computed offset (0..1), in order. */
  offsets: number[];
  /** The offsets of the keyframes that set an opacity (pairs with `opacities`). */
  opacityOffsets: number[];
  /** It runs inside a talking waveform (`.ix-wave`): the one motion allowed to go on while someone talks (§1.2, §4.4). */
  talking: boolean;
  /** `composite` of the effect (`replace`, `add`). */
  composite: string;
  /** `fill` of the effect. */
  fill: string;
  /** When it was created, in ms after the moment's mark. */
  at: number;
  /** `running`, `finished`, `idle` (canceled), `paused`, at the time of `describe`. */
  playState: string;
}

declare global {
  interface Window {
    __ixMotion?: {
      /** Every animation since the last mark: the live object, its target, when. */
      log: Array<{ animation: Animation; at: number }>;
      mark: number;
      seen: WeakSet<Animation>;
    };
  }
}

/**
 * Install the recorder. Call before the first `page.goto` (an init script runs
 * on every load, so a reload keeps it).
 */
export async function installMotionRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const bag = { log: [] as Array<{ animation: Animation; at: number }>, mark: performance.now(), seen: new WeakSet<Animation>() };
    window.__ixMotion = bag;
    const keep = (animation: Animation | null | undefined) => {
      if (!animation || bag.seen.has(animation)) return;
      bag.seen.add(animation);
      bag.log.push({ animation, at: performance.now() - bag.mark });
    };
    const original = Element.prototype.animate;
    Element.prototype.animate = function animate(this: Element, ...args: Parameters<Element['animate']>) {
      const animation = original.apply(this, args);
      keep(animation);
      return animation;
    };
    // CSS: the event names the property (or @keyframes) and the element; the
    // CSSTransition / CSSAnimation object is the element's running one.
    const fromEvent = (event: Event, match: (animation: Animation) => boolean) => {
      const target = event.target as Element | null;
      if (!target || typeof target.getAnimations !== 'function') return;
      for (const animation of target.getAnimations()) if (match(animation)) keep(animation);
    };
    window.addEventListener(
      'transitionrun',
      (event) => {
        const { propertyName, pseudoElement } = event as TransitionEvent;
        fromEvent(event, (animation) => {
          const effect = animation.effect as (KeyframeEffect & { pseudoElement?: string | null }) | null;
          return (
            typeof CSSTransition !== 'undefined'
            && animation instanceof CSSTransition
            && animation.transitionProperty === propertyName
            && (effect?.pseudoElement ?? '') === (pseudoElement ?? '')
          );
        });
      },
      true,
    );
    window.addEventListener(
      'animationstart',
      (event) => {
        const { animationName } = event as AnimationEvent;
        fromEvent(event, (animation) => typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation && animation.animationName === animationName);
      },
      true,
    );
  });
}

/** Forget everything recorded so far and start the clock of a new moment. */
export async function markMoment(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bag = window.__ixMotion;
    if (!bag) throw new Error('the motion recorder is not installed (installMotionRecorder before goto)');
    bag.log = [];
    bag.mark = performance.now();
  });
}

/** Everything recorded since the mark, as plain data. */
export async function describeMoment(page: Page): Promise<MotionRecord[]> {
  return page.evaluate(() => {
    const bag = window.__ixMotion;
    if (!bag) throw new Error('the motion recorder is not installed');
    const name = (el: Element | null | undefined, pseudo: string | null | undefined) => {
      if (!el) return 'detached';
      const tag = el.tagName.toLowerCase();
      // `getAttribute`: an SVG's `className` is not a string (the sidebar's chevron is an svg).
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      const html = el as HTMLElement;
      const hint = html.dataset?.testid ?? html.dataset?.place ?? html.dataset?.ixTint ?? '';
      return `${tag}${cls ? `.${cls}` : ''}${hint ? `[${hint}]` : ''}${pseudo ?? ''}`;
    };
    const meta = new Set(['offset', 'computedOffset', 'easing', 'composite']);
    return bag.log.map(({ animation, at }) => {
      const effect = animation.effect as (KeyframeEffect & { pseudoElement?: string | null }) | null;
      const timing = effect?.getTiming?.();
      const computed = effect?.getComputedTiming?.();
      const keyframes = (effect?.getKeyframes?.() ?? []) as Array<Keyframe & { easing?: string; composite?: string }>;
      const properties = new Set<string>();
      for (const keyframe of keyframes) for (const key of Object.keys(keyframe)) if (!meta.has(key)) properties.add(key);
      const isTransition = typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition;
      const isCss = typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation;
      const iterations = Number(timing?.iterations ?? 1);
      const loops = iterations === Infinity;
      const duration = Number(timing?.duration ?? 0) || 0;
      return {
        kind: isTransition ? 'transition' : isCss ? 'animation' : 'web',
        id: isTransition
          ? (animation as CSSTransition).transitionProperty
          : isCss
            ? (animation as CSSAnimation).animationName
            : animation.id,
        target: name(effect?.target, effect?.pseudoElement),
        duration: loops ? null : Math.round(duration * iterations),
        delay: Number(timing?.delay ?? 0) || 0,
        loops,
        easing: String(timing?.easing ?? 'linear'),
        keyframeEasings: keyframes.map((k) => String(k.easing ?? 'linear')).filter((e) => e !== 'linear'),
        properties: [...properties],
        transforms: keyframes.filter((k) => k.transform !== undefined).map((k) => String(k.transform)),
        opacities: keyframes.filter((k) => k.opacity !== undefined).map((k) => String(k.opacity)),
        offsets: keyframes.map((k) => Number((k as { computedOffset?: number }).computedOffset ?? k.offset ?? 0)),
        opacityOffsets: keyframes
          .filter((k) => k.opacity !== undefined)
          .map((k) => Number((k as { computedOffset?: number }).computedOffset ?? k.offset ?? 0)),
        talking: Boolean((effect?.target as Element | null | undefined)?.closest?.('.ix-wave')),
        composite: String((effect as KeyframeEffect | null)?.composite ?? 'replace'),
        fill: String(timing?.fill ?? 'auto'),
        at: Math.round(at),
        playState: computed && animation.playState === 'running' && computed.progress === null ? 'pending' : animation.playState,
      } satisfies MotionRecord as MotionRecord;
    });
  });
}

/**
 * Every animation the document holds right now (`document.getAnimations()`:
 * running, paused, or finished and still filling), as `kind:id:state@target`.
 * The gate asserts this is empty two seconds after each moment settles
 * (index-spec §5, plan §5.4: "`document.getAnimations().length === 0` two
 * seconds after every §5 moment settles"). A talking waveform is left out
 * unless `talking` is set: it is the one motion that goes on while someone
 * talks (§1.2), and the gate holds it to "only while someone talks" itself.
 */
export async function runningNow(page: Page, { talking = false }: { talking?: boolean } = {}): Promise<string[]> {
  return page.evaluate((keepTalking) =>
    document.getAnimations()
      .filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target as Element | null | undefined;
        return keepTalking || !target?.closest?.('.ix-wave');
      })
      .map((animation) => {
        const effect = animation.effect as (KeyframeEffect & { pseudoElement?: string | null }) | null;
        const el = effect?.target as HTMLElement | null | undefined;
        const kind = typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition
          ? `transition:${(animation as CSSTransition).transitionProperty}`
          : typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation
            ? `animation:${(animation as CSSAnimation).animationName}`
            : `web:${animation.id || '(no id)'}`;
        const cls = el ? (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
        return `${kind}:${animation.playState}@${el ? `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}` : 'detached'}${effect?.pseudoElement ?? ''}`;
      }), talking);
}
