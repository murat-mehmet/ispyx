// The drag laser: an eye beside the drag line fires a thick beam at the spot just behind the pointer, as if the pointer
// were running from it. Pure drawing into premultiplied BGRA buffers (Layer.px) and the placement rules; scan.js
// runs it (ScanAnimation.laser). Colours stay in the ispyx green family, brighter and glassier than the flat trail.

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

export const LASER_EYE_SIZE = 112;
export const BURN_LIFE_MS = 2000;
export const BEAM_WIDTH = 26; // half-width in px of the full beam

/**
 * Where the eye goes: beside the line a -> b (never on it), at a random place along it and on a random side, as far
 * from the line as the monitor `mon` {x, y, width, height} allows (up to size/2 + 190 px). Returns the eye centre.
 */
export function placeEye(a, b, mon, size = LASER_EYE_SIZE, rand = Math.random) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const f = 0.3 + 0.4 * rand();
  const mx = a.x + (b.x - a.x) * f, my = a.y + (b.y - a.y) * f;
  const half = size / 2, margin = 10;
  const fits = (c) => c.x - half >= mon.x + margin && c.x + half <= mon.x + mon.width - margin && c.y - half >= mon.y + margin && c.y + half <= mon.y + mon.height - margin;
  const first = rand() < 0.5 ? 1 : -1;
  for (const d of [half + 190, half + 130, half + 80]) {
    for (const s of [first, -first]) {
      const c = { x: mx + nx * s * d, y: my + ny * s * d };
      if (fits(c)) return c;
    }
  }
  // no room on either side (a drag across a whole small screen): the side with more room, kept on the monitor
  const c = { x: mx + nx * first * (half + 80), y: my + ny * first * (half + 80) };
  return { x: clamp(c.x, mon.x + margin + half, mon.x + mon.width - margin - half), y: clamp(c.y, mon.y + margin + half, mon.y + mon.height - margin - half) };
}

/** Premultiplied "over": add colour (r, g, b) with coverage a at pixel index i. */
function over(px, i, r, g, b, a) {
  if (a <= 0) return;
  const k = 1 - a;
  px[i] = b * a + px[i] * k; px[i + 1] = g * a + px[i + 1] * k; px[i + 2] = r * a + px[i + 2] * k; px[i + 3] = a * 255 + px[i + 3] * k;
}

/** A glowing flare at (cx, cy): white core, green/cyan halo, a ring and slowly turning spikes. `w` is the beam half-width. */
function flare(px, W, H, cx, cy, w, tMs, strength) {
  const R = Math.ceil(w * 3.6);
  const rot = tMs * 0.0011;
  for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(H - 1, Math.ceil(cy + R)); y++) {
    for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(W - 1, Math.ceil(cx + R)); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      if (r > R) continue;
      const i = (y * W + x) * 4;
      const halo = Math.exp(-((r / (w * 2.1)) ** 2)) * 0.55 * strength;
      over(px, i, 40, 235, 170, halo);
      const ring = clamp(1 - Math.abs(r - w * 1.9) / 1.6) * 0.55 * strength;
      over(px, i, 170, 255, 220, ring);
      const ang = Math.atan2(dy, dx);
      const spike = (Math.max(0, Math.cos(6 * (ang + rot))) ** 22) * Math.exp(-r / (w * 1.5)) * 0.9 * strength;
      over(px, i, 200, 255, 225, spike);
      const core = Math.exp(-((r / (w * 1.05)) ** 2)) * strength;
      over(px, i, 240, 255, 246, core);
    }
  }
}

/**
 * The beam from (ax, ay) to (bx, by) with half-width `w` (0 = off): rounded ends and the same width all along, a soft green glow, an emerald body that
 * darkens towards its rim, a white-green core, energy bands running along it, and a flare at each end.
 * `tMs` animates the bands and the spikes.
 */
export function renderBeam(px, W, H, ax, ay, bx, by, w, tMs) {
  if (w < 0.5) return;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const pad = Math.ceil(w * 3.2);
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + pad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - ax, dy = y + 0.5 - ay;
      const s = clamp(dx * ux + dy * uy, 0, len); // rounded ends: distance to the segment
      const d = Math.hypot(dx - s * ux, dy - s * uy);
      if (d > w * 3.1) continue;
      const i = (y * W + x) * 4;
      const hw = w; // the same width along its whole length
      const band = 0.86 + 0.14 * Math.sin(s * 0.11 - tMs * 0.045);
      over(px, i, 20, 200, 120, Math.exp(-((d / (hw * 2.3)) ** 2)) * 0.5); // outer glow
      const body = clamp(hw - d + 0.5);
      if (body > 0) {
        const e = clamp(d / hw);
        const k = e * e; // 0 in the middle, 1 on the rim
        over(px, i, mix(70, 8, k) * band, mix(255, 130, k) * band, mix(150, 80, k) * band, body * 0.97);
        const core = clamp(hw * 0.52 - d + 0.5) * (0.9 + 0.1 * band);
        over(px, i, 238, 255, 244, core);
      }
    }
  }
  flare(px, W, H, ax, ay, w, tMs, 0.85);
  flare(px, W, H, bx, by, w, tMs + 400, 1);
}

/** A thick line piece; the stronger alpha wins where pieces overlap (so a burn trail has no beads at its joints). */
function stroke(px, W, H, x0, y0, x1, y1, radius, rgb, alpha) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  const R = Math.ceil(radius + 1);
  for (let s = 0; s <= n; s++) {
    const cx = x0 + ((x1 - x0) * s) / n, cy = y0 + ((y1 - y0) * s) / n;
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(H - 1, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(W - 1, Math.ceil(cx + R)); x++) {
        const a = clamp(radius + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)) * alpha;
        const i = (y * W + x) * 4;
        if (a * 255 <= px[i + 3]) continue;
        px[i] = rgb[2] * a; px[i + 1] = rgb[1] * a; px[i + 2] = rgb[0] * a; px[i + 3] = a * 255;
      }
    }
  }
}

/**
 * The scorch the beam leaves: pts = [{ x, y, t }] (buffer pixels, ms stamps), now = ms. Fresh pieces glow lime-white,
 * cool to a charred dark line with a faint green ember rim, and disappear after BURN_LIFE_MS.
 */
export function renderBurn(px, W, H, pts, now) {
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 1; k < pts.length; k++) {
      const age = now - pts[k].t;
      const fade = Math.pow(clamp(1 - age / BURN_LIFE_MS), 0.8);
      if (fade <= 0.02) continue;
      const A = pts[k - 1], B = pts[k];
      if (pass === 0) stroke(px, W, H, A.x, A.y, B.x, B.y, 13, [22, 120, 66], 0.3 * fade);
      else if (pass === 1) stroke(px, W, H, A.x, A.y, B.x, B.y, 9, [10, 16, 13], 0.82 * fade);
      else {
        const heat = clamp(1 - age / 320);
        if (heat <= 0.03) continue;
        stroke(px, W, H, A.x, A.y, B.x, B.y, 3.5 + 5 * heat, [mix(90, 235, heat), 255, mix(130, 215, heat)], heat * 0.95);
      }
    }
  }
}

/** Sparks flying off the impact point: [{ x, y, vx, vy, t0, life }] (px, px/ms, ms). Returns the ones still alive. */
export function renderSparks(px, W, H, sparks, now) {
  const alive = [];
  for (const s of sparks) {
    const age = now - s.t0;
    if (age >= s.life) continue;
    alive.push(s);
    const f = 1 - age / s.life;
    const x = s.x + s.vx * age, y = s.y + s.vy * age + 0.0005 * age * age;
    const px0 = x - s.vx * 26 * f, py0 = y - s.vy * 26 * f;
    stroke(px, W, H, px0, py0, x, y, 0.9 + 1.2 * f, [210, 255, 225], f);
  }
  return alive;
}

/** New sparks at (x, y), flying away from the beam source (ax, ay) in a fan. */
export function spawnSparks(list, x, y, ax, ay, now, count = 2, rand = Math.random) {
  const base = Math.atan2(y - ay, x - ax);
  for (let n = 0; n < count; n++) {
    const ang = base + (rand() - 0.5) * 2.4;
    const v = 0.12 + rand() * 0.34;
    list.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, t0: now, life: 260 + rand() * 260 });
  }
}
