/**
 * A Web Animations stub for jsdom (test-only; never imported by the app).
 *
 * jsdom implements no animation engine at all — `Element.animate` does not
 * exist — so the engine's recipes correctly no-op there and a unit test can
 * observe nothing. This records what WOULD have been played: the keyframes, the
 * timing, and the element it was played on, which is exactly what the §5 tests
 * assert on (the visual half is the Playwright motion gate).
 */

export interface RecordedAnimation {
  target: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: Animation;
  canceled: boolean;
  finished: boolean;
}

export interface WaapiStub {
  played: RecordedAnimation[];
  restore(): void;
  /** Every animation the stub still considers relevant (mirrors getAnimations). */
  live(): RecordedAnimation[];
}

export function installWaapiStub(): WaapiStub {
  const played: RecordedAnimation[] = [];
  const original = (Element.prototype as { animate?: unknown }).animate;
  const originalGet = (Element.prototype as { getAnimations?: unknown }).getAnimations;

  function animate(this: Element, keyframes: Keyframe[] | null, options?: number | KeyframeAnimationOptions) {
    const timing: KeyframeAnimationOptions = typeof options === 'number' ? { duration: options } : { ...options };
    const record: RecordedAnimation = {
      target: this,
      keyframes: keyframes ?? [],
      options: timing,
      canceled: false,
      finished: false,
      animation: null as unknown as Animation,
    };
    let settle: () => void = () => {};
    let fail: (reason?: unknown) => void = () => {};
    const finishedPromise = new Promise<Animation>((resolve, reject) => {
      settle = () => resolve(record.animation);
      fail = reject;
    });
    // A rejected `.finished` with no handler is an unhandled rejection in node.
    finishedPromise.catch(() => {});
    const listeners = new Map<string, Set<() => void>>();
    const animation: Record<string, unknown> = {
      id: '',
      playState: 'running',
      currentTime: 0,
      effect: {
        getComputedTiming: () => ({ duration: timing.duration ?? 0 }),
      },
      finished: finishedPromise,
      finish() {
        record.finished = true;
        animation.playState = 'finished';
        settle();
      },
      cancel() {
        record.canceled = true;
        animation.playState = 'idle';
        for (const listener of listeners.get('cancel') ?? []) listener();
        fail(new DOMException('The user aborted a request.', 'AbortError'));
      },
      addEventListener(type: string, listener: () => void) {
        const set = listeners.get(type) ?? new Set();
        listeners.set(type, set);
        set.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
    };
    record.animation = animation as unknown as Animation;
    played.push(record);
    return record.animation;
  }

  function getAnimations(this: Element) {
    return played
      .filter((record) => record.target === this && !record.canceled && !record.finished)
      .map((record) => record.animation);
  }

  (Element.prototype as { animate?: unknown }).animate = animate;
  (Element.prototype as { getAnimations?: unknown }).getAnimations = getAnimations;

  return {
    played,
    live: () => played.filter((record) => !record.canceled && !record.finished),
    restore() {
      if (original) (Element.prototype as { animate?: unknown }).animate = original;
      else delete (Element.prototype as { animate?: unknown }).animate;
      if (originalGet) (Element.prototype as { getAnimations?: unknown }).getAnimations = originalGet;
      else delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
      played.length = 0;
    },
  };
}
