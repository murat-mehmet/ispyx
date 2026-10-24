// Builds Ispyx/Resources/Ispyx.icns: the eye of the screenshot animation (renderEye in src/effects/scan.js) on a
// dark rounded square, in every size an .iconset needs. Run with any Node from this folder:
//   node make-icon.mjs        (needs iconutil, which ships with macOS)
// build.sh copies the result into the app; rerun this only when the eye or the background changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../src/core/image.js';
import { renderEye } from '../../src/effects/scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'Ispyx', 'Resources', 'Ispyx.icns');

const clamp = (v) => Math.min(1, Math.max(0, v));

/** RGBA (straight alpha) icon of size s: Apple's grid puts the 824/1024 squircle in the middle of the canvas. */
function renderIcon(s) {
  const rgba = Buffer.alloc(s * s * 4);
  const k = s / 1024;
  const inset = 100 * k, side = 824 * k, rad = 185 * k;
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispyx-icon-'));
const set = path.join(dir, 'Ispyx.iconset');
fs.mkdirSync(set);
for (const base of [16, 32, 128, 256, 512]) {
  for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
    const s = base * scale;
    fs.writeFileSync(path.join(set, `icon_${base}x${base}${suffix}.png`), encodePng(renderIcon(s), s, s));
  }
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', OUT]);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`written: ${OUT}`);
