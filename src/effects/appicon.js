// The Ispyx app icon: the eye of the screenshot animation (renderEye in scan.js) on a dark rounded square. One source
// for the macOS .icns (native/macos/make-icon.mjs) and the Windows tray icon (platform/win32/tray-worker.js).
import { renderEye } from './scan.js';

const clamp = (v) => Math.min(1, Math.max(0, v));

/**
 * RGBA (straight alpha) icon of size s. By default Apple's grid is used: the 824/1024 squircle sits in the middle of
 * the canvas. tight: true fills the whole canvas (small tray icons).
 */
export function renderIcon(s, { tight = false } = {}) {
  const rgba = Buffer.alloc(s * s * 4);
  const k = s / 1024;
  const inset = tight ? 0 : 100 * k, side = tight ? s : 824 * k, rad = side * (185 / 824);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // signed distance to the rounded square
      const qx = Math.abs(x + 0.5 - s / 2) - (side / 2 - rad);
      const qy = Math.abs(y + 0.5 - s / 2) - (side / 2 - rad);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
      const a = clamp(0.5 - sd);
      if (a <= 0) continue;
      // dark green-black, a little lighter at the top
      const t = (y - inset) / side;
      const i = (y * s + x) * 4;
      rgba[i] = 18 + 14 * (1 - t); rgba[i + 1] = 30 + 22 * (1 - t); rgba[i + 2] = 26 + 14 * (1 - t); rgba[i + 3] = a * 255;
    }
  }
  // the eye (premultiplied BGRA sprite) over the background, looking a little down like it does in the animation
  const e = Math.round(side * 0.78);
  const px = new Uint8Array(e * e * 4);
  renderEye(px, e, 1, 0, 0.35);
  const ox = Math.round((s - e) / 2), oy = Math.round((s - e) / 2);
  for (let y = 0; y < e; y++) {
    for (let x = 0; x < e; x++) {
      const j = (y * e + x) * 4, sa = px[j + 3] / 255;
      if (sa <= 0) continue;
      const i = ((oy + y) * s + ox + x) * 4, da = rgba[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      // premultiplied source over straight-alpha destination, back to straight alpha
      for (const [c, sc] of [[0, 2], [1, 1], [2, 0]]) rgba[i + c] = (px[j + sc] + rgba[i + c] * da * (1 - sa)) / oa;
      rgba[i + 3] = oa * 255;
    }
  }
  return rgba;
}
