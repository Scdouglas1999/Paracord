/**
 * A CSS `cubic-bezier(x1, y1, x2, y2)` as a function of time, for the call
 * view's counter-layer samples (`components/ix/call/callMotion.ts`): the curve
 * a browser would apply, read back at any `t`.
 */

/** Newton's method on x(u) = t, bisection when the slope is too flat to trust. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (u: number) => ((ax * u + bx) * u + cx) * u;
  const y = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const solve = (t: number): number => {
    let u = t;
    for (let i = 0; i < 8; i += 1) {
      const error = x(u) - t;
      if (Math.abs(error) < 1e-6) return u;
      const slope = dx(u);
      if (Math.abs(slope) < 1e-6) break;
      u -= error / slope;
    }
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 40; i += 1) {
      const value = x(u);
      if (Math.abs(value - t) < 1e-6) return u;
      if (value < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return y(solve(t));
  };
}
