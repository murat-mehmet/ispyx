// Human-like pointer paths: a curved cubic Bezier with a smooth (minimum-jerk) speed profile.
const lerp = (a, b, t) => a + (b - a) * t;
const between = (rand, lo, hi) => lo + (hi - lo) * rand();

/** Slow start, fast middle, slow arrival. t in 0..1 -> progress in 0..1. */
export const ease = (t) => t * t * t * (10 + t * (-15 + 6 * t));

/** Returns point(t) for a gently curved path from `from` to `to`. The bend side and size are random. */
export function curvedPath(from, to, rand = Math.random) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return () => ({ x: to.x, y: to.y });
  const nx = -dy / dist; // unit normal
  const ny = dx / dist;
  const side = rand() < 0.5 ? -1 : 1;
  const bend1 = side * dist * between(rand, 0.08, 0.22);
  const bend2 = side * dist * between(rand, 0.0, 0.14);
  const c1 = { x: from.x + dx * 0.3 + nx * bend1, y: from.y + dy * 0.3 + ny * bend1 };
  const c2 = { x: from.x + dx * 0.72 + nx * bend2, y: from.y + dy * 0.72 + ny * bend2 };
  return (t) => {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return {
      x: a * from.x + b * c1.x + c * c2.x + d * to.x,
      y: a * from.y + b * c1.y + c * c2.y + d * to.y,
    };
  };
}

/** Random travel time in milliseconds, 300..1000 by default. */
export const randomDuration = (min = 300, max = 1000, rand = Math.random) => Math.round(between(rand, min, max));
